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
//
// THE OWNER CAN ALWAYS CLOSE HIS OWN TASK (fix round 3, orchestrator ruling): `by:'owner'` — the
// dashboard drag, his approval of a complete override, his project close — is never refused. What
// was left is recorded on the task ("Closed by the owner with N <unit> left") once the close lands.
import { getDb } from '../db/connection.js';
import { pendingCloseRequestExpr } from './tracker-view.js';
import { appendAuditEntry } from './audit-trail.js';

const permits = new Set<string>();

/** Run `close` with this task's named remainder honoured by the writer. Synchronous on purpose:
 *  the permit cannot outlive the call it was granted for. */
export function withNamedRemainder<T>(taskId: string, close: () => T): T {
  permits.add(taskId);
  try { return close(); } finally { permits.delete(taskId); }
}

/** A measured task's last stored reading and unit; null when it is not measured or was not read. */
function lastReading(id: string): { left: number; unit: string; pending: boolean } | null {
  const row = getDb().prepare(
    `SELECT w.measure_json AS m, w.measure_remaining AS left, ${pendingCloseRequestExpr('w')} AS pending
       FROM work w WHERE w.id = ? AND w.kind = 'task'`,
  ).get(id) as { m: string | null; left: number | null; pending: number } | undefined;
  if (!row?.m || row.left === null) return null;
  let unit = 'items';
  try { unit = String((JSON.parse(row.m) as { unit?: string }).unit ?? 'items'); } catch { /* the count is the fact */ }
  return { left: row.left, unit, pending: row.pending === 1 };
}

/** How many items a measured task's last reading says are left (0: unmeasured, unread, or done). */
export function measuredItemsLeft(id: string): number {
  return lastReading(id)?.left ?? 0;
}

export function measuredCloseRefusal(
  id: string, status: string, input: { by: string },
): { kind: 'refused'; workId: string; reason: 'measure-items-left'; detail: string } | null {
  if (status !== 'complete' || permits.has(id) || input.by === 'owner') return null;
  const r = lastReading(id);
  if (!r || r.left === 0 || r.pending) return null;
  return {
    kind: 'refused', workId: id, reason: 'measure-items-left',
    detail: `its measure still returned ${r.left} ${r.unit} when last read, so the task is not done; `
      + 'it closes when the measure reads 0, or when its agent closes it naming what is left',
  };
}

/** After an APPLIED owner close of a measured task with items left: what was left, on the record. */
export function recordOwnerRemainder(id: string, status: string, input: { by: string }): void {
  if (status !== 'complete' || input.by !== 'owner') return;
  const r = lastReading(id);
  if (r && r.left > 0) appendAuditEntry(id, 'owner', { entryKind: 'observation', note: `Closed by the owner with ${r.left} ${r.unit} left.` });
}

/** The run word a run that ended with its task's measure still listing items carries on its settle
 *  event. The occurrence itself settles `abandoned`, the existing honest non-complete terminal for a
 *  run (the deliver stand-down's); the owner's run history reads it "Incomplete — N <unit> left"
 *  (`work/occurrence-runs.ts`). Never `complete`, and only for a run the deliverable gate would have
 *  recorded complete; the schedule still advances, so the next run fires. */
export const RUN_STATUS_INCOMPLETE = 'incomplete';

/** A run about to be recorded `complete`: what its task's measure says is left, or null (nothing
 *  left, unmeasured, unread, or this close named its remainder at the agent's door, now or through
 *  a close request the PM is blessing). */
export function runItemsLeft(occurrenceId: string): { taskId: string; left: number; unit: string } | null {
  const occ = getDb().prepare("SELECT parent_id AS p, sequence AS n FROM work WHERE id = ? AND kind = 'occurrence'")
    .get(occurrenceId) as { p: string | null; n: number | null } | undefined;
  if (!occ?.p || permits.has(occ.p) || closeRequestedThisRun(occ.p, occurrenceId)) return null;
  const r = lastReading(occ.p);
  return r && r.left > 0 ? { taskId: occ.p, left: r.left, unit: r.unit } : null;
}

/** The writer's pending-close-request rule, for a run: a close request the agent filed on the task
 *  during THIS run crossed the agent's door, which re-read and judged it (named remainder or zero).
 *  The PM's Key 2 on it settles the run after the request is spent, so "pending" is asked as "filed
 *  since the run opened, and not thrown back". */
function closeRequestedThisRun(taskId: string, occurrenceId: string): boolean {
  const row = getDb().prepare(
    `SELECT MAX(e.id) AS req FROM work_events e
      WHERE e.work_id = ? AND e.kind = 'validation_requested'
        AND json_extract(e.payload, '$.requested_state') = 'done'
        AND e.created_at >= (SELECT opened_at FROM work WHERE id = ?)`,
  ).get(taskId, occurrenceId) as { req: number | null };
  if (row.req === null) return false;
  const thrownBack = getDb().prepare(
    "SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'claim_rejected' AND id > ? LIMIT 1",
  ).get(taskId, row.req);
  return !thrownBack;
}

/** The remainder of a run recorded incomplete, on its task's own record (the PM and the owner read it). */
export function recordRunRemainder(occurrenceId: string, left: { taskId: string; left: number; unit: string }): void {
  appendAuditEntry(left.taskId, 'scheduler', {
    entryKind: 'observation',
    note: `A run ended with ${left.left} ${left.unit} left by its measure; it is recorded incomplete, not complete, and the schedule moves on (run ${occurrenceId.slice(0, 8)}).`,
  });
}
