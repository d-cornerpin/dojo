import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { sendAlert } from './imessage-bridge.js';

const logger = createLogger('memory-low-notice');

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
export function noteCriticalMemory(freeMb: number): void {
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
