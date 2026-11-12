// The scheduler's own 30 s clock, independent of the project manager. A tick that outruns the period must
// not let a second tick walk the same due set: overlaps are skipped and counted, and the guard releases
// in a `finally` so a throwing tick cannot wedge the clock.

import { createLogger } from '../logger.js';
import { kickBalanceCheck, kickMemoryRecheck, kickLivenessSweep, backgroundChecksSettled } from './background-checks.js';

const logger = createLogger('scheduler-clock');

/** How often the scheduler asks what is due; work/work-reaper.ts cites this 30 s period in its cadences. */
export const SCHEDULER_INTERVAL_MS = 30_000;

type TickBody = () => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let overlapsSkipped = 0;

export function schedulerClockState(): {
  running: boolean; inFlight: boolean; overlapsSkipped: number; everyMs: number;
} {
  return { running: timer !== null, inFlight, overlapsSkipped, everyMs: SCHEDULER_INTERVAL_MS };
}

export const balanceCheckSettled = backgroundChecksSettled;

/** The default tick body: background kicks around the due scan. Injectable so the guard can be driven. */
const defaultBody: TickBody = async () => {
  kickBalanceCheck();
  const { checkScheduledTasks } = await import('./runner.js');
  await checkScheduledTasks();
  kickMemoryRecheck(); // after the due scan: never ahead of it, never awaited by it
  kickLivenessSweep();
};

/** Run one tick unless one is in flight (`'skipped'`). Never throws: a `setInterval` rejection is unhandled. */
export async function runSchedulerTick(body: TickBody = defaultBody): Promise<'ran' | 'skipped'> {
  if (inFlight) {
    overlapsSkipped += 1;
    logger.warn('Scheduler tick skipped: the previous tick is still running', {
      overlapsSkipped, everyMs: SCHEDULER_INTERVAL_MS,
    });
    return 'skipped';
  }
  inFlight = true;
  try {
    await body();
  } catch (err) {
    logger.error('Scheduler tick failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
  return 'ran';
}

/** Install the scheduler's interval. Idempotent: a second call is a no-op, not a second clock. */
export function startScheduler(): void {
  if (timer) return;
  // Run once at once so a freshly restarted box does not wait a full period for overdue work.
  void runSchedulerTick();
  timer = setInterval(() => { void runSchedulerTick(); }, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  logger.info(`Scheduler started, checking every ${SCHEDULER_INTERVAL_MS / 1000}s`);
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('Scheduler stopped');
}
