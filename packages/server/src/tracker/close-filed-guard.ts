import { getDb } from '../db/connection.js';
import { TERMINAL_STATE_NAMES } from '../work/terminal-states.js';
import { setTaskStatusResult } from './schema.js';
import { workSettled, isStateConflict } from '../work/store.js';

/**
 * A block or pause VERDICT must never be the thing that answers a worker's filed close.
 *
 * `throwBackClaim` (a reject) writes `claim_rejected`, which `pendingCloseRequestExpr` reads as
 * the answer to "is this job finished?", and a bless of the stale wait/obstacle note answers a
 * question the row has moved past. The queues no longer select such a row for the block or
 * pause lens, so only a stale id reaches these doors; the refusal points at the door that IS
 * open so the validator's next call is the right one.
 */
export function closeFiledRefusal(
  task: { title: string; close_request_filed: number }, taskId: string, noun: 'pause' | 'block',
): string | null {
  if (task.close_request_filed !== 1) return null;
  return (
    `Error: task "${task.title}" (${taskId.slice(0, 8)}) has filed a CLOSE REQUEST — its worker says the ${noun === 'pause' ? 'wait' : 'obstacle'} is over and the work is done. ` +
    `A ${noun} verdict (bless or reject) would answer a question this row has moved past and drop the close unjudged. ` +
    `Judge the close instead: work_validate(action="validate", kind="complete", task_id="${taskId}", valid=true|false, reject_reason="..." if false).`
  );
}

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
  return st && (TERMINAL_STATE_NAMES as readonly string[]).includes(st) ? st : null;
}

/**
 * The agent doors' answer to a schedule change on a FINISHED task. An agent cannot reopen a
 * finished row (the product refuses that reopen), and a schedule armed on one is ended by the
 * fire-time writer, so the door refuses BEFORE any write and says exactly what happened.
 */
export function finishedScheduleRefusal(taskId: string, title: string, doing: string): string | null {
  const st = finishedStateOf(taskId);
  if (!st) return null;
  return `Error: "${title}" (${taskId.slice(0, 8)}) is finished (${st}), so its schedule cannot be ${doing}. Nothing was changed. Only the owner can restart a finished task, from the dashboard.`;
}

/** The owner door: a schedule set on a FINISHED task means "run it again". Reopen it with the
 *  owner's authority (a finished row's only way back is `open`, status 'active'; `on_deck` is
 *  where a recurring task waits), so the schedule is armed on a live row. Null, or the refusal. */
export function reopenFinishedForNewSchedule(taskId: string): string | null {
  if (!finishedStateOf(taskId)) return null;
  for (const to of ['active', 'on_deck'] as const) {
    const { result } = setTaskStatusResult(taskId, to, {
      by: 'owner', actorId: 'user', claim: 'authoritative',
      reason: 'the owner set a new schedule on a finished task (dashboard PUT /tracker/tasks/:id)',
    });
    if (!workSettled(result)) {
      return `the task is finished and could not be reopened to take the new schedule — ${isStateConflict(result) ? `it moved to "${result.actual}"` : `${result.reason}: ${result.detail}`}`;
    }
  }
  return null;
}
