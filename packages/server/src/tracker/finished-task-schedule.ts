// A schedule set on a FINISHED task. Every door that can arm one must first make the row live or refuse,
// because the fire-time writer (`work/next-run.ts`) records a schedule armed on a settled row as ended.
import { getDb } from '../db/connection.js';
import { withUnit, afterCommit } from '../db/unit.js';
import { broadcast } from '../gateway/ws.js';
import { isTerminalName } from '../work/terminal-states.js';
import { setTrackerStatus } from '../work/tracker-store.js';
import { workSettled, isStateConflict, type WorkOutcome, type WorkPatchOutcome } from '../work/store.js';
import { stateToStatus } from '../work/tracker-view.js';
import { getTask } from './schema.js';
import { createLogger } from '../logger.js';

const logger = createLogger('finished-task-schedule');

export function finishedStateOf(taskId: string): string | null {
  const st = (getDb().prepare('SELECT state FROM work WHERE id = ?').get(taskId) as { state: string } | undefined)?.state;
  return isTerminalName(st) ? st! : null;
}

/** True when the schedule fields would SET a schedule (undefined is untouched; null or '' clears). */
export const setsASchedule = (values: readonly unknown[]): boolean =>
  values.some((v) => v !== undefined && v !== null && v !== '');

/** The agent doors' refusal of a schedule change on a FINISHED task, made before any write. */
export function finishedScheduleRefusal(taskId: string, title: string, doing: string): string | null {
  const st = finishedStateOf(taskId);
  if (!st) return null;
  return `Error: "${title}" (${taskId.slice(0, 8)}) is finished (${stateToStatus(st)}), so its schedule cannot be ${doing}. Nothing was changed. Only the owner can restart a finished task, from the dashboard.`;
}

class ReopenRefused extends Error {}
const refusedWhy = (o: WorkOutcome | WorkPatchOutcome): string =>
  isStateConflict(o as WorkOutcome) ? `it moved to "${(o as { actual: string }).actual}"` : o.kind === 'refused' ? `${o.reason}: ${o.detail}` : 'it could not be written';

/** The OWNER door's write: a finished row is reopened and armed in ONE unit (both or neither). Returns
 *  null or the plain-words refusal. The caller has already computed everything `arm` writes. */
export function armScheduleOnOwnerSave(taskId: string, arm: () => WorkPatchOutcome): string | null {
  const finished = finishedStateOf(taskId);
  const unsettled = (o: WorkPatchOutcome): boolean => o.kind !== 'applied' && o.kind !== 'no_change';
  try {
    withUnit(() => {
      if (finished) {
        const hop = setTrackerStatus(taskId, 'on_deck', {
          by: 'owner', actorId: 'user',
          reason: 'the owner set a new schedule on a finished task',
        });
        if (!workSettled(hop)) throw new ReopenRefused(refusedWhy(hop));
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
