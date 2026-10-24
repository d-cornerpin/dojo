// v3.5 DONE IS MEASURED — the tracker's side of a task's measure: storing one that was set, and
// the REMAINDER RULE at the close door.
//
// The I/O half (parsing the wire value, the agent's grants, counting) is async and lives at the
// door that has the awaits (`agent/tools/cat/measure-door.ts`); the close doors here are
// synchronous, so they judge the reading that door just stored on the row. A close reached by any
// other path judges the last stored reading, which is the conservative answer.
import { getDb } from '../db/connection.js';
import { parseMeasure, describeMeasure, type Measure, type MeasureCount } from '../work/measure.js';
import { ledgerTotals, setMeasure } from '../work/ledger-store.js';
import { writeTaskLog } from './task-log.js';
import { resolveTaskId, formatResolveError } from './schema.js';
import { taskWriteRefusal } from '../work/row-authority.js';

/** A measure the async door validated and read once, handed to the synchronous creator. */
export interface MeasureReading { measure: Measure; count: MeasureCount; at: number }

/** The minimum length of a named remainder's reason: the same floor the paused and blocked doors
 *  apply to their reasons (`tracker/tools.ts`, MIN_PAUSE_NOTES_LEN / MIN_BLOCKED_NOTES_LEN). */
const MIN_REMAINDER_REASON_LEN = 15;

/** Store a measure on a task and say what it reads now (one line for the OK text). */
export function applyMeasureToTask(taskId: string, r: MeasureReading): string {
  setMeasure(taskId, r.measure, r.count, r.at);
  return r.count.ok
    ? `Measure set: ${describeMeasure(r.measure)} returns ${r.count.count} ${r.measure.unit} now. It is done when that reads 0, or when you name what is left.`
    : `Measure set: ${describeMeasure(r.measure)} could not be read now (${r.count.error}).`;
}

/** work_update(action="edit") with a measure: the task's editors set it, and it starts a new scope. */
export function editMeasure(agentId: string, rawTaskId: string, r: MeasureReading): { line: string } | { error: string } {
  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return { error: formatResolveError('task', rawTaskId, resolved) };
  const refused = taskWriteRefusal(agentId, resolved.id, 'edit');
  return refused ? { error: refused } : { line: applyMeasureToTask(resolved.id, r) };
}

/** A measured task's close: items left and not named are refused. Null = the close may proceed. */
export function remainderGate(agentId: string, taskId: string, args: Record<string, unknown>, door = 'status="complete"'): string | null {
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null } | undefined;
  if (!row?.measure_json) return null;
  let raw: unknown;
  try { raw = JSON.parse(row.measure_json); } catch { return null; }
  const parsed = parseMeasure(raw);
  // A stored measure that no longer parses cannot bind the close; an unread one (an outage) never
  // refuses it: the reading's `measured` event says it could not be read, and the PM sees that.
  if (!parsed.ok || row.measure_remaining === null || row.measure_remaining === 0) return null;
  const left = row.measure_remaining;
  const { unit } = parsed.measure;
  const rem = args.remainder as { disposition?: unknown; reason?: unknown } | undefined;
  const reason = typeof rem?.reason === 'string' ? rem.reason.trim() : '';
  if ((rem?.disposition === 'skipped' || rem?.disposition === 'blocked') && reason.length >= MIN_REMAINDER_REASON_LEN) {
    // Named: the PM judges the number and the reason.
    writeTaskLog({ taskId, fromEntity: `agent:${agentId}`, entryKind: 'observation', note: `Remainder named at close: ${left} ${unit} ${rem.disposition} — ${reason}` });
    return null;
  }
  const ledger = ledgerTotals(taskId);
  return (
    `Refused: ${door} on a measured task. Its measure (${describeMeasure(parsed.measure)}) still returns ${left} ${unit} ` +
    `(${row.measure_initial ?? '?'} when the task started; ${ledger.touched} touched so far). The task is not done. ` +
    `Continue working through what the measure lists. If the rest genuinely cannot or should not be done, say which and why: ` +
    `status="blocked" with the reason, or close again with remainder={disposition:"skipped", reason:"<why these ${left} are left>"}; the PM sees that count and your reason.`
  );
}
