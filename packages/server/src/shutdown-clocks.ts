// Stops the work reaper and scheduler first in shutdown(), before anything they depend on goes away.
// Each stop is idempotent and separately try/caught so one failure cannot skip the other.
import { stopReaper } from './work/work-reaper.js';
import { stopScheduler } from './scheduler/clock.js';
import { createLogger } from './logger.js';

const logger = createLogger('shutdown-clocks');

export function stopBackgroundClocks(): void {
  try { stopReaper(); } catch (err) {
    logger.warn('work reaper stop failed', { error: err instanceof Error ? err.message : String(err) });
  }
  try { stopScheduler(); } catch (err) {
    logger.warn('scheduler stop failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
