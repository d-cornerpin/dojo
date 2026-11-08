// The tracker's side of a task's measure: storing one that was set. The I/O half (parsing the wire
// value, the agent's grants, counting) is async and lives at `agent/tools/cat/measure-door.ts`; the
// hand-in door judges the reading stored on the row.
import { describeMeasure, type Measure, type MeasureCount } from '../work/measure.js';
import { setMeasure } from '../work/ledger-store.js';
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
