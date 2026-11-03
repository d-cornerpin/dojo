// A schedule set on a FINISHED task: one subject, one module.
//
// The fire-time writer (`work/next-run.ts`) records a schedule armed on a settled row as ended, so
// every door that can arm one must first make the row live or refuse. The owner's dashboard save
// means "run this again" and reopens the row; the agent doors cannot reopen a finished row (the
// product refuses that) and refuse up front, before any write.
import { getDb } from '../db/connection.js';
import { withUnit, afterCommit } from '../db/unit.js';
import { broadcast } from '../gateway/ws.js';
import { isTerminalName } from '../work/terminal-states.js';
import { setTrackerStatus, resetRevertCount } from '../work/tracker-store.js';
import { workSettled, isStateConflict, type WorkOutcome, type WorkPatchOutcome } from '../work/store.js';
import { awaitingUserVerdictExpr, stateToStatus } from '../work/tracker-view.js';
import { getTask } from './schema.js';
import { createLogger } from '../logger.js';

const logger = createLogger('finished-task-schedule');

/**
 * ONE test for "this task is a live recurring schedule" — the filer (`work_update` status and
 * complete_step) and the validator (`work_validate` complete) used to each spell their own
 * (`schedule_status !== 'unscheduled' && repeat_interval` vs `repeat_interval !== null`), so a
 * row one called recurring the other treated as a one-shot, or the reverse.
 */
export const isScheduledRecurring = (
  scheduleStatus: string | null | undefined, repeatInterval: number | null | undefined,
): boolean => scheduleStatus !== 'unscheduled' && !!repeatInterval;

/** The row's state when it is finished (done, failed or abandoned); null when it is still live. */
export function finishedStateOf(taskId: string): string | null {
  const st = (getDb().prepare('SELECT state FROM work WHERE id = ?').get(taskId) as { state: string } | undefined)?.state;
  return isTerminalName(st) ? st! : null;
}

/** True when an edit's schedule fields would SET a schedule: undefined is untouched, and null or
 *  '' is the supported way to CLEAR one, which arms nothing. */
export const setsASchedule = (values: readonly unknown[]): boolean =>
  values.some((v) => v !== undefined && v !== null && v !== '');

/**
 * The agent doors' answer to a schedule change on a FINISHED task. An agent cannot reopen a
 * finished row, so the door refuses BEFORE any write and says exactly what happened, in the
 * owner-facing status words (complete / fallen / cancelled).
 */
export function finishedScheduleRefusal(taskId: string, title: string, doing: string): string | null {
  const st = finishedStateOf(taskId);
  if (!st) return null;
  return `Error: "${title}" (${taskId.slice(0, 8)}) is finished (${stateToStatus(st)}), so its schedule cannot be ${doing}. Nothing was changed. Only the owner can restart a finished task, from the dashboard.`;
}

class ReopenRefused extends Error {}
const refusedWhy = (o: WorkOutcome | WorkPatchOutcome): string =>
  isStateConflict(o as WorkOutcome) ? `it moved to "${(o as { actual: string }).actual}"` : o.kind === 'refused' ? `${o.reason}: ${o.detail}` : 'it could not be written';

/**
 * The OWNER door's write. A live row just takes the schedule. A FINISHED row means "run it again":
 * the reopen hops (a finished row's only way back is `open`, status 'active'; `on_deck` is where a
 * recurring task waits) and the schedule write land in ONE unit, so either the task comes back
 * armed or nothing changes at all. The caller has already computed everything `arm` writes.
 * Returns null, or the plain-words refusal (the unit has rolled back).
 */
export function armScheduleOnOwnerSave(taskId: string, arm: () => WorkPatchOutcome): string | null {
  const finished = finishedStateOf(taskId);
  const unsettled = (o: WorkPatchOutcome): boolean => o.kind !== 'applied' && o.kind !== 'no_change';
  try {
    withUnit(() => {
      if (finished) {
        for (const to of ['active', 'on_deck'] as const) {
          const hop = setTrackerStatus(taskId, to, {
            by: 'owner', actorId: 'user', claim: 'authoritative',
            reason: 'the owner set a new schedule on a finished task (dashboard PUT /tracker/tasks/:id)',
          });
          if (!workSettled(hop)) throw new ReopenRefused(refusedWhy(hop));
        }
        // Same as the status branch of this PUT: a person moving a task resets its revert count
        // unless it is awaiting his verdict. Inside the unit, so a landed reopen never answers 500.
        const awaiting = getDb().prepare(`SELECT ${awaitingUserVerdictExpr('w')} AS a FROM work w WHERE w.id = ?`).get(taskId) as { a: number } | undefined;
        if (awaiting?.a !== 1) resetRevertCount(taskId, 'user', 'dashboard transition');
      }
      const armed = arm();
      if (unsettled(armed)) throw new ReopenRefused(refusedWhy(armed));
      if (finished) afterCommit(() => { const t = getTask(taskId); if (t) broadcast({ type: 'tracker:task_updated', data: t }); });
    });
  } catch (err) {
    if (err instanceof ReopenRefused) return finished ? `the task is finished and could not be reopened to take the new schedule — ${err.message}` : `the schedule could not be saved — ${err.message}`;
    logger.error('owner schedule save failed and was rolled back', { taskId, error: err instanceof Error ? err.message : String(err) });
    throw new Error('the new schedule could not be saved, and nothing was changed.');
  }
  return null;
}
