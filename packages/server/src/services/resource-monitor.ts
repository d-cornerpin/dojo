// ════════════════════════════════════════
// Resource Monitor: Memory + Spawn Gating
// ════════════════════════════════════════

import os from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from './imessage-bridge.js';
import { getDb } from '../db/connection.js';

const logger = createLogger('resource-monitor');

const MIN_FREE_MEMORY_MB = 1024; // 1GB
let lastWarningTime = 0;
const WARNING_COOLDOWN_MS = 60000; // 1 minute between warnings

export interface ResourceInfo {
  memory: {
    total: number;  // MB
    used: number;   // MB
    free: number;   // MB
  };
  cpu: {
    loadAvg: number[];
  };
}

/**
 * Get memory info using macOS `vm_stat` which accounts for purgeable/cached memory.
 * os.freemem() only reports "free" pages, ignoring inactive/purgeable memory
 * that macOS can reclaim instantly — making it look like 99% used when it's really ~50%.
 */
function getMacMemoryMb(): { total: number; used: number; free: number } {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  try {
    const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });
    const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const parsePage = (label: string): number => {
      const match = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
      return match ? parseInt(match[1], 10) : 0;
    };

    // "App Memory" = wired + active (this matches Activity Monitor's "Memory Used" closely)
    const wired = parsePage('Pages wired down');
    const active = parsePage('Pages active');
    const compressed = parsePage('Pages occupied by compressor');

    const usedPages = wired + active + compressed;
    const usedMb = Math.round((usedPages * pageSize) / (1024 * 1024));
    const freeMb = Math.max(0, totalMb - usedMb);

    return { total: totalMb, used: usedMb, free: freeMb };
  } catch {
    const freeMem = os.freemem();
    return {
      total: totalMb,
      used: Math.round((os.totalmem() - freeMem) / (1024 * 1024)),
      free: Math.round(freeMem / (1024 * 1024)),
    };
  }
}

export function getResourceInfo(): ResourceInfo {
  const memory = getMacMemoryMb();

  return {
    memory,
    cpu: {
      loadAvg: os.loadavg(),
    },
  };
}

// ── MEMORY BELOW 512MB: TOLD ONCE PER LOW STRETCH (t138 round 3) ──
//
// The critical text used to ride the one-minute cooldown of the dashboard's low-memory warning,
// so a box that stayed low texted the owner once a minute for as long as it stayed low. Owner
// ruling (2026-10-13): no hard limits; "the Dojo should be smart enough to know when enough is
// enough". So it texts when memory FALLS below the line and again only after it was seen back
// above it. The latch is a config row (`{ at, dismissedAt? }`), so a restart in the middle of a
// low stretch does not text again, and the same words wait on the owner's dashboard until he
// dismisses them (ruling R-V333-13).
const CRITICAL_FREE_MB = 512;
const MEMORY_LOW_WORDS = 'Critical: System memory below 512MB. Terminate idle sub-agents.';

function readMemoryLow(): { at: number; dismissedAt?: number } | null {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'owner_notice_memory_low'").get() as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as { at: number; dismissedAt?: number } : null; } catch { return { at: 0 }; }
}

function writeMemoryLow(value: { at: number; dismissedAt?: number } | null): void {
  const db = getDb();
  if (value === null) db.prepare("DELETE FROM config WHERE key = 'owner_notice_memory_low'").run();
  else db.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('owner_notice_memory_low', ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(JSON.stringify(value));
}

/** Memory measured: tell the owner when it falls below the line, re-arm when it is back above. */
function noteCriticalMemory(freeMb: number): void {
  try {
    const low = freeMb < CRITICAL_FREE_MB;
    const told = readMemoryLow();
    if (low && told === null) {
      writeMemoryLow({ at: Date.now() });
      sendAlert(MEMORY_LOW_WORDS, 'critical');
    } else if (!low && told !== null) {
      writeMemoryLow(null);
    }
  } catch (err) {
    logger.warn('Critical-memory notice check failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The memory owner card a dashboard shows on load: told, still low as last measured, not dismissed. */
export function memoryOwnerCards(): Array<{ words: string; severity: 'critical'; dismiss: () => void }> {
  const told = readMemoryLow();
  if (told === null || told.dismissedAt !== undefined) return [];
  return [{ words: MEMORY_LOW_WORDS, severity: 'critical', dismiss: () => writeMemoryLow({ ...told, dismissedAt: Date.now() }) }];
}

export function canSpawnAgent(): { allowed: boolean; reason?: string } {
  const info = getResourceInfo();
  noteCriticalMemory(info.memory.free);

  if (info.memory.free < MIN_FREE_MEMORY_MB) {
    const now = Date.now();
    if (now - lastWarningTime > WARNING_COOLDOWN_MS) {
      lastWarningTime = now;

      logger.warn('Low memory warning', {
        freeMb: info.memory.free,
        totalMb: info.memory.total,
        threshold: MIN_FREE_MEMORY_MB,
      });

      broadcast({
        type: 'resource:warning',
        data: {
          type: 'memory',
          freeMb: info.memory.free,
          totalMb: info.memory.total,
          threshold: MIN_FREE_MEMORY_MB,
        },
      });
    }

    return {
      allowed: false,
      reason: `Insufficient memory: ${info.memory.free}MB free (minimum ${MIN_FREE_MEMORY_MB}MB required)`,
    };
  }

  return { allowed: true };
}
