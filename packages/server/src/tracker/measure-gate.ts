// The tracker's side of a task's measure: storing one that was set, and the remainder rule at complete_task.
//
// The I/O half (parsing the wire value, the agent's grants, counting) is async and lives at the
// door that has the awaits (`agent/tools/cat/measure-door.ts`); the close doors here are
// synchronous, so they judge the reading that door just stored on the row. A close reached by any
// other path judges the last stored reading, which is the conservative answer.
import { getDb } from '../db/connection.js';
import { parseMeasure, describeMeasure, type Measure, type MeasureCount } from '../work/measure.js';
import { ledgerTotals, setMeasure } from '../work/ledger-store.js';
import { resolveTaskId, formatResolveError } from './schema.js';
import { taskWriteRefusal } from '../work/row-authority.js';

/** A measure the async door validated and read once, handed to the synchronous creator. */
export interface MeasureReading { measure: Measure; count: MeasureCount; at: number }

/** Store a measure on a task and say what it reads now (one line for the OK text). */
export function applyMeasureToTask(taskId: string, r: MeasureReading): string {
  setMeasure(taskId, r.measure, r.count, r.at);
  return r.count.ok
    ? `Measure set: ${describeMeasure(r.measure)} returns ${r.count.count} ${r.measure.unit} now. It is done when that reads 0.`
    : `Measure set: ${describeMeasure(r.measure)} could not be read now (${r.count.error}).`;
}

/** work_update(action="edit") with a measure: the task's editors set it, and it starts a new scope. */
export function editMeasure(agentId: string, rawTaskId: string, r: MeasureReading): { line: string } | { error: string } {
  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return { error: formatResolveError('task', rawTaskId, resolved) };
  const refused = taskWriteRefusal(agentId, resolved.id, 'edit');
  return refused ? { error: refused } : { line: applyMeasureToTask(resolved.id, r) };
}

/** What a measured task's close is judged on: its measure and the reading the door just stored. */
function closeFacts(taskId: string): { measure: Measure; initial: number | null; left: number } | null {
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null } | undefined;
  if (!row?.measure_json) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.measure_json); } catch { return null; }
  const parsed = parseMeasure(raw);
  // A stored measure that no longer parses cannot bind the close; an unread one (an outage, or a
  // read the agent may no longer make) never refuses it: the reading's `measured` event says it
  // could not be read, and the PM sees that.
  if (!parsed.ok || row.measure_remaining === null || row.measure_remaining === 0) return null;
  return { measure: parsed.measure, initial: row.measure_initial, left: row.measure_remaining };
}

/** A measured task with items left is not done: the door that would finish it (complete_task, 2c) is refused,
 *  naming the hand-in that takes a remainder. Null = nothing is left, or the measure could not be read. */
export function remainderRefusal(taskId: string, door: string): string | null {
  const f = closeFacts(taskId);
  if (!f) return null;
  return (
    `Refused: ${door} on a measured task. Its measure (${describeMeasure(f.measure)}) still returns ${f.left} ${f.measure.unit} ` +
    `(${f.initial ?? '?'} when the task started; ${ledgerTotals(taskId).touched} touched so far). The task is not done. ` +
    `Items that genuinely cannot or should not be done are handed in as can't be done, with a remainder item naming them and why: ` +
    `work_update(action="hand_in", outcome="cant_be_done", proof=[{kind:"remainder", ref:"${f.left} ${f.measure.unit}", reason:"<why>"}]).`
  );
}
