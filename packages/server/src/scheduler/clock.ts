// ════════════════════════════════════════════════════════════════════════════════════════
// THE SCHEDULER'S CLOCK — SWEEP-F T2, via SWEEP CORE-2 item 3.
//
// ── WHAT THIS TAKES BACK, AND FROM WHOM ─────────────────────────────────────────────────
// Until this module the platform's answer to "when does a schedule fire" was installed by
// `tracker/pm-agent.ts:startPokeLoop()` — the PROJECT MANAGER's start-up routine — which
// declared `SCHEDULER_INTERVAL_MS`, held `schedulerTimer`, and cleared it in `stopPokeLoop()`.
// Two consequences followed from that one coupling, and neither was written down anywhere:
//
//   1. A box with the PM DISABLED fired no schedules at all. `index.ts` 4c starts the PM
//      under `isSetupCompleted() && isPMEnabled()`, and the scheduler's only start was inside
//      it. Turning off the project manager silently turned off every reminder and every
//      recurring task on the box.
//   2. `stopPokeLoop()` stopped the scheduler too. A caller that wanted the PM quiet got the
//      clock stopped as a side effect it never asked for and could not see.
//
// The period is CARRIED, not re-chosen: 30 seconds, the exact value `tracker/pm-agent.ts`
// declared, which is also `work/work-reaper.ts`'s `REAPER_BASE_TICK_MS` and the cadence three
// reaper kinds cite as "the 30s scheduler tick". Re-picking it here would have silently moved
// a clock four other things are measured against.
//
// ── THE RE-ENTRANCY GUARD, AND WHY THE TICK NEEDED ONE ──────────────────────────────────
// `checkScheduledTasks` is async and awaits: the due scan's cleanup, `claimOccurrence`, and —
// through `onTaskRunComplete` — the agent runtime itself. A tick that outran the 30-second
// period therefore had a SECOND tick walking the same due set while the first was still
// deciding what to fire. Nothing crashed, because D21's occurrence claim is a UNIQUE
// constraint and the loser skips; what was lost was the ability to say so. The overlap was
// invisible, uncounted, and indistinguishable from "the schedule was already claimed
// elsewhere" in the log.
//
// So the guard does not merely prevent the overlap — it COUNTS it. `overlapsSkipped` is the
// honest measure of a tick that cannot keep up with its own period, which is a real operating
// condition on a loaded box and one nobody could previously see.
//
// The guard releases in a `finally`: a tick that THROWS must not wedge the clock for ever,
// and that arm is driven by its own test rather than argued for in a comment.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';

const logger = createLogger('scheduler-clock');

/**
 * How often the scheduler asks "what is due".
 *
 * CARRIED VERBATIM from `tracker/pm-agent.ts`'s `SCHEDULER_INTERVAL_MS = 30_000` — the value
 * this module took ownership of, not a new one. `work/work-reaper.ts` names this clock in
 * three of its kinds' `cadenceFrom` strings, so moving the number moves those too.
 */
export const SCHEDULER_INTERVAL_MS = 30_000;

type TickBody = () => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let overlapsSkipped = 0;

/** What the clock is doing. Exported so "is the scheduler keeping up" is answerable. */
export function schedulerClockState(): {
  running: boolean; inFlight: boolean; overlapsSkipped: number; everyMs: number;
} {
  return { running: timer !== null, inFlight, overlapsSkipped, everyMs: SCHEDULER_INTERVAL_MS };
}

/** The default body: the scheduler's own due scan. Injectable so the guard can be driven. */
const defaultBody: TickBody = async () => {
  const { checkScheduledTasks } = await import('./runner.js');
  await checkScheduledTasks();
};

/**
 * Run ONE scheduler tick, refusing to re-enter one that is already running.
 *
 * Returns `'skipped'` when a tick was already in flight — the caller's tick did not happen and
 * the count says so. Never throws: the timer must survive a failing tick, and a rejected
 * promise on a `setInterval` callback is an unhandled rejection.
 */
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

/**
 * Install the scheduler's own interval. Idempotent — a second call is a no-op rather than a
 * second clock, the same discipline `startReaper()` keeps.
 */
export function startScheduler(): void {
  if (timer) return;
  // The immediate first pass, carried from the PM's version of this block: a box that has
  // just come back up must not wait a full period before it looks at what is overdue.
  void runSchedulerTick();
  timer = setInterval(() => { void runSchedulerTick(); }, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  logger.info(`Scheduler started, checking every ${SCHEDULER_INTERVAL_MS / 1000}s`);
}

/** Stop the scheduler's clock. Stopping the PM no longer does this by accident. */
export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('Scheduler stopped');
}
