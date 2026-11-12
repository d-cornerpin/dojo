// A measured task's last stored reading, as read by the hand-in door, proof and the owner's close (`work/done/`)
// and by the run settle (`work/occurrences.ts`).
import { getDb } from '../db/connection.js';
import { handedInExpr } from './tracker-view.js';
import { appendAuditEntry } from './audit-trail.js';

const singular = (unit: string): string =>
  /(?:x|ch|sh|ss)es$/.test(unit) ? unit.slice(0, -2) : /[^s]s$/.test(unit) ? unit.slice(0, -1) : unit;
export const countOf = (n: number, unit: string): string => `${n} ${n === 1 ? singular(unit) : unit}`;

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

/** A MEASURED task whose last reading is 0, the only reading an engine close may count; null when unmeasured,
 *  unread, or items are left. It must be a 0 the count CAME DOWN to (`measure_initial > 0`): a measure that read
 *  0 from the start counted nothing (wrong glob, wrong folder), and an engine close names no remainder. */
export function measureReadsZero(id: string): { unit: string } | null {
  const r = lastReading(id);
  return r && r.left === 0 && (r.initial ?? 0) > 0 ? { unit: r.unit } : null;
}

export function measuredItemsLeft(id: string): number {
  return lastReading(id)?.left ?? 0;
}

export function recordOwnerRemainder(id: string): void {
  const r = lastReading(id);
  if (r && r.left > 0) appendAuditEntry(id, 'owner', { entryKind: 'observation', note: `Closed by the owner with ${countOf(r.left, r.unit)} left.` });
}

/** The run word for a run that ended with its measure still listing items. The occurrence settles `abandoned`
 *  and the schedule still advances; the run history reads it "Incomplete" (`work/occurrence-runs.ts`). */
export const RUN_STATUS_INCOMPLETE = 'incomplete';

export function runItemsLeft(occurrenceId: string): { taskId: string; left: number; unit: string } | null {
  const occ = getDb().prepare("SELECT parent_id AS p, sequence AS n FROM work WHERE id = ? AND kind = 'occurrence'")
    .get(occurrenceId) as { p: string | null; n: number | null } | undefined;
  if (!occ?.p || closeRequestedThisRun(occ.p, occurrenceId)) return null;
  const r = lastReading(occ.p);
  return r && r.left > 0 ? { taskId: occ.p, left: r.left, unit: r.unit } : null;
}

/** Handed in during THIS run: the hand-in door already judged its measure, so no incomplete mark. */
function closeRequestedThisRun(taskId: string, occurrenceId: string): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM work_events h WHERE h.work_id = ? AND h.kind = 'handed_in'
        AND h.id >= (SELECT MIN(e.id) FROM work_events e WHERE e.work_id = ?) LIMIT 1`,
  ).get(taskId, occurrenceId);
}

export function recordRunRemainder(occurrenceId: string, left: { taskId: string; left: number; unit: string }): void {
  appendAuditEntry(left.taskId, 'scheduler', {
    entryKind: 'observation',
    note: `A run ended with ${countOf(left.left, left.unit)} left by its measure; it is recorded incomplete, not complete, and the schedule moves on (run ${occurrenceId.slice(0, 8)}).`,
  });
}
