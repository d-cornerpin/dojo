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
import { handedInExpr } from './tracker-view.js';
import { appendAuditEntry } from './audit-trail.js';

/** "1 message", "1 box", "5 messages": a count of the measure's unit, in the owner's words. Only a
 *  trailing plural "s" comes off ("boxes"/"batches"/"addresses" lose "es"; "messages" loses "s"). */
const singular = (unit: string): string =>
  /(?:x|ch|sh|ss)es$/.test(unit) ? unit.slice(0, -2) : /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit;
export const countOf = (n: number, unit: string): string => `${n} ${n === 1 ? singular(unit) : unit}`;

/** A measured task's last stored reading and unit; null when it is not measured or was not read. */
function lastReading(id: string): { left: number; initial: number | null; unit: string; pending: boolean } | null {
  const row = getDb().prepare(
    `SELECT w.measure_json AS m, w.measure_remaining AS left, w.measure_initial AS initial, ${handedInExpr('w')} AS pending
       FROM work w WHERE w.id = ? AND w.kind = 'task'`,
  ).get(id) as { m: string | null; left: number | null; initial: number | null; pending: number } | undefined;
  if (!row?.m || row.left === null) return null;
  let unit = 'items';
  try { unit = String((JSON.parse(row.m) as { unit?: string }).unit ?? 'items'); } catch { /* the count is the fact */ }
  return { left: row.left, initial: row.initial, unit, pending: row.pending === 1 };
}

/** v3.5 field fix 3 review round 4: a MEASURED task whose last stored reading is 0, which is what an
 *  engine close may count (done is measured). Null when unmeasured, unread, or items are left.
 *  Re-review 2 (S2): and only a 0 the count CAME DOWN to (`measure_initial > 0`), the PM uphold's own
 *  rule (`tracker/looked-at.ts` closeBacking). A measure that read 0 from the start counted nothing:
 *  a wrong-case glob, the wrong folder, a query matching nothing. An engine close names no remainder,
 *  so the remainder arm is the worker's, at its own door. */
export function measureReadsZero(id: string): { unit: string } | null {
  const r = lastReading(id);
  return r && r.left === 0 && (r.initial ?? 0) > 0 ? { unit: r.unit } : null;
}

/** How many items a measured task's last reading says are left (0: unmeasured, unread, or done). */
export function measuredItemsLeft(id: string): number {
  return lastReading(id)?.left ?? 0;
}

/** After the owner closed a measured task with items left: what was left, on the record. */
export function recordOwnerRemainder(id: string): void {
  const r = lastReading(id);
  if (r && r.left > 0) appendAuditEntry(id, 'owner', { entryKind: 'observation', note: `Closed by the owner with ${countOf(r.left, r.unit)} left.` });
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
  if (!occ?.p || closeRequestedThisRun(occ.p, occurrenceId)) return null;
  const r = lastReading(occ.p);
  return r && r.left > 0 ? { taskId: occ.p, left: r.left, unit: r.unit } : null;
}

/** The writer's pending-close-request rule (`handedInExpr`), for a run: a close request
 *  the agent filed on the task during THIS run (event-id order: after the run's first event) crossed
 *  the agent's door, which re-read and judged it (named remainder or zero). It counts while pending,
 *  and once the PM's Key 2 answered it with the close, since the run is settled after that; a
 *  throw-back (a rejection, a reopen) answers it the other way. */
function closeRequestedThisRun(taskId: string, occurrenceId: string): boolean {
  const db = getDb();
  const r = db.prepare(
    `SELECT ${handedInExpr('w')} AS pending,
            (SELECT MAX(e.id) FROM work_events e WHERE e.work_id = w.id AND e.kind = 'handed_in') AS req,   -- 2c
            (SELECT MIN(e.id) FROM work_events e WHERE e.work_id = ?) AS run_start
       FROM work w WHERE w.id = ?`,
  ).get(occurrenceId, taskId) as { pending: number; req: number | null; run_start: number | null } | undefined;
  if (!r || r.req === null || r.run_start === null || r.req < r.run_start) return false;
  if (r.pending === 1) return true;
  const answer = db.prepare(
    `SELECT kind, json_extract(payload, '$.to') AS to_state FROM work_events
      WHERE work_id = ? AND id > ? AND (kind = 'claim_rejected' OR (kind = 'transition'
        AND json_extract(payload, '$.to') IN ('done', 'failed', 'abandoned', 'open')))
      ORDER BY id LIMIT 1`,
  ).get(taskId, r.req) as { kind: string; to_state: string | null } | undefined;
  return answer?.kind === 'transition' && answer.to_state === 'done';
}

/** The remainder of a run recorded incomplete, on its task's own record (the PM and the owner read it). */
export function recordRunRemainder(occurrenceId: string, left: { taskId: string; left: number; unit: string }): void {
  appendAuditEntry(left.taskId, 'scheduler', {
    entryKind: 'observation',
    note: `A run ended with ${countOf(left.left, left.unit)} left by its measure; it is recorded incomplete, not complete, and the schedule moves on (run ${occurrenceId.slice(0, 8)}).`,
  });
}
