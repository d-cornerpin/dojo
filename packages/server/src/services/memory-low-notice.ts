import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { sendAlert } from './imessage-bridge.js';
import { ownerConditionCleared, tellOwner } from '../healer/owner-notices.js';

const logger = createLogger('memory-low-notice');

// Told once per low stretch: texts when memory falls below the line, again only after it was seen back above.
// The latch is a config row, so a restart mid-stretch does not text again; card `memory-low` stands with it.
const CRITICAL_FREE_MB = 512;
const MEMORY_LOW_WORDS = 'Your Mac has less than 512 MB of memory free, so the Dojo may slow down or stop. Quitting apps you are not using frees memory.';

function readMemoryLow(): { at: number } | null {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'owner_notice_memory_low'").get() as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as { at: number } : null; } catch { return { at: 0 }; }
}

function writeMemoryLow(value: { at: number } | null): void {
  if (value === null) getDb().prepare("DELETE FROM config WHERE key = 'owner_notice_memory_low'").run();
  else setConfigValue('owner_notice_memory_low', JSON.stringify(value));
}

/** Memory measured: tell the owner when it falls below the line, re-arm when it is back above. */
export function noteCriticalMemory(freeMb: number): void {
  try {
    const low = freeMb < CRITICAL_FREE_MB;
    const told = readMemoryLow();
    if (low && told === null) {
      writeMemoryLow({ at: Date.now() });
      tellOwner('memory-low', MEMORY_LOW_WORDS);
      void sendAlert(MEMORY_LOW_WORDS, 'critical', { kind: 'mac-critical' });
    } else if (!low && told !== null) {
      writeMemoryLow(null);
      ownerConditionCleared('memory-low');
    }
  } catch (err) {
    logger.warn('Critical-memory notice check failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** True while the owner was told memory is low and it has not recovered; the scheduler tick re-measures. */
export function memoryLowStanding(): boolean {
  try { return readMemoryLow() !== null; } catch { return false; }
}
