// v3.5 DONE IS MEASURED (fix round 2, orchestrator ruling: EVERY way to mark a task complete) —
// the rule at the tracker's ONE status writer (`work/tracker-store.ts` `setTrackerStatus`), which
// every close crosses: the agent's doors, and the engine's own closes that no door sees (the
// same-turn receipt close, the A2A deliverable close request, the PM's receipt close, the
// join-drive card release, a group deletion's orphans, the scheduler's last-run and recovery
// closes, `complete_task`).
//
// The writer is synchronous, so it judges the measure's LAST STORED reading: a close is refused
// while that reading shows items left. Three things let a close through, each a judgement already
// made by someone entitled to make it:
//   - the reading is 0, or could not be taken (an outage never refuses a close);
//   - the task already carries a pending close request: that request crossed the agent's door,
//     which re-read the measure and judged it (named remainder or zero), so the PM's Key 2 on it
//     is the PM's call (Part E hands the PM the measure, the ledger and the remainder);
//   - the door that just judged THIS close (`agent/tools/cat/measure-door.ts`) found the
//     remainder named, and holds a permit for the duration of its own synchronous close.
// An engine close never names a remainder, so with items left it never closes a measured task.
import { getDb } from '../db/connection.js';
import { pendingCloseRequestExpr } from './tracker-view.js';

const permits = new Set<string>();

/** Run `close` with this task's named remainder honoured by the writer. Synchronous on purpose:
 *  the permit cannot outlive the call it was granted for. */
export function withNamedRemainder<T>(taskId: string, close: () => T): T {
  permits.add(taskId);
  try { return close(); } finally { permits.delete(taskId); }
}

export function measuredCloseRefusal(
  id: string, status: string,
): { kind: 'refused'; workId: string; reason: 'measure-items-left'; detail: string } | null {
  if (status !== 'complete' || permits.has(id)) return null;
  const row = getDb().prepare(
    `SELECT w.measure_json AS m, w.measure_remaining AS left, ${pendingCloseRequestExpr('w')} AS pending
       FROM work w WHERE w.id = ? AND w.kind = 'task'`,
  ).get(id) as { m: string | null; left: number | null; pending: number } | undefined;
  if (!row?.m || row.left === null || row.left === 0 || row.pending === 1) return null;
  let unit = 'items';
  try { unit = String((JSON.parse(row.m) as { unit?: string }).unit ?? 'items'); } catch { /* the count is the fact */ }
  return {
    kind: 'refused', workId: id, reason: 'measure-items-left',
    detail: `its measure still returned ${row.left} ${unit} when last read, so the task is not done; `
      + 'it closes when the measure reads 0, or when its agent closes it naming what is left',
  };
}
