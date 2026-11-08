// ── STOPPING THE BACKGROUND CLOCKS (shutdown step 1) ──
//
// `shutdown()` in `index.ts` used to stop only the FTS repair, the reader pool, the video
// poller and the tunnel, then wait for `server.close(cb)` — a window that can be long with open
// websocket connections, and during it the two clocks started at boot (the work reaper and the
// scheduler) kept waking agents, sending owner notices and writing rows.
// This is the ONE place they are all stood down, and it runs as the FIRST action of shutdown,
// before anything they depend on is torn down.
//
// Each stop is idempotent and safe if never started, and each is wrapped in its own try/catch so
// one failing stop cannot skip the others.
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
