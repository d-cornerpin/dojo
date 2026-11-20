// Storing a task's measure; the async I/O half (parse, grants, count) is `agent/tools/cat/measure-door.ts`.
import { describeMeasure, type Measure, type MeasureCount } from '../work/measure.js';
import { setMeasure, type MeasureSetter } from '../work/ledger-store.js';
import { resolveTaskId, formatResolveError } from './schema.js';
import { standardEditRefusal, taskWriteRefusal } from '../work/row-authority.js';

/** A measure the async door validated and read once, handed to the synchronous creator. */
export interface MeasureReading { measure: Measure; count: MeasureCount; at: number }

export function applyMeasureToTask(taskId: string, r: MeasureReading, by: MeasureSetter): string {
  setMeasure(taskId, r.measure, r.count, r.at, by);
  return r.count.ok
    ? `Measure set: ${describeMeasure(r.measure)} returns ${r.count.count} ${r.measure.unit} now. It is done when that reads 0.`
    : `Measure set: ${describeMeasure(r.measure)} could not be read now (${r.count.error}).`;
}

/** work_update(action="edit") with a measure: the task's editors set it, and it starts a new scope. */
export function editMeasure(agentId: string, rawTaskId: string, r: MeasureReading): { line: string } | { error: string } {
  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return { error: formatResolveError('task', rawTaskId, resolved) };
  const refused = taskWriteRefusal(agentId, resolved.id, 'edit') ?? standardEditRefusal(agentId, resolved.id);
  return refused ? { error: refused } : { line: applyMeasureToTask(resolved.id, r, { setBy: agentId }) };
}
