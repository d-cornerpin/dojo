// ════════════════════════════════════════
// Resource Monitor: Memory + Spawn Gating
// ════════════════════════════════════════

import os from 'node:os';
import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from './imessage-bridge.js';

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

export function canSpawnAgent(): { allowed: boolean; reason?: string } {
  const info = getResourceInfo();

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
      } as never);

      // Critical iMessage alert when memory drops below 512MB
      if (info.memory.free < 512) {
        sendAlert('Critical: System memory below 512MB. Terminate idle sub-agents.', 'critical');
      }
    }

    return {
      allowed: false,
      reason: `Insufficient memory: ${info.memory.free}MB free (minimum ${MIN_FREE_MEMORY_MB}MB required)`,
    };
  }

  return { allowed: true };
}
