// The tracker's side of a task's measure: storing one that was set, and the remainder rule at the close
// doors (items left are closed only with a named remainder the one proof check accepts).
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
import { checkProof } from '../work/done/proof.js';
import { readAuditTrail } from '../work/audit-trail.js';

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

/** The remainder this close names, when the proof check accepts it as a remainder item: `skipped` or
 *  `blocked`, with a reason. */
function namedRemainder(taskId: string, agentId: string, left: string, args: Record<string, unknown>): { disposition: string; reason: string } | null {
  const rem = args.remainder as { disposition?: unknown; reason?: unknown } | undefined;
  if (rem?.disposition !== 'skipped' && rem?.disposition !== 'blocked') return null;
  const reason = typeof rem.reason === 'string' ? rem.reason.trim() : '';
  const proof = checkProof(taskId, agentId, 'cant_be_done', [{ kind: 'remainder', ref: `${left} ${rem.disposition}`, facts: { reason } }]);
  return proof.ok ? { disposition: rem.disposition, reason } : null;
}

/**
 * The remainder rule every door that marks a measured task complete asks: items left and not named are
 * refused. Null = the close may proceed. It writes nothing; a named remainder is recorded by the door
 * once the close has landed (`namedRemainderNote`). `takesRemainder` is false at a door that has no
 * `remainder` argument (the schedule door), whose refusal therefore names the door that does.
 */
export function remainderRefusal(
  taskId: string, agentId: string, args: Record<string, unknown>, door = 'status="complete"', takesRemainder = true,
): string | null {
  const f = closeFacts(taskId);
  if (!f || (takesRemainder && namedRemainder(taskId, agentId, `${f.left} ${f.measure.unit}`, args))) return null;
  const { unit } = f.measure;
  const named = `remainder={disposition:"skipped", reason:"<why these ${f.left} are left>"}`;
  return (
    `Refused: ${door} on a measured task. Its measure (${describeMeasure(f.measure)}) still returns ${f.left} ${unit} ` +
    `(${f.initial ?? '?'} when the task started; ${ledgerTotals(taskId).touched} touched so far). The task is not done. ` +
    `What the measure lists is what remains. Items that genuinely cannot or should not be done are a remainder: ` +
    `${named}${takesRemainder ? '' : ' (taken by work_update(action="status"), not by this door)'}; ` +
    `blocked work is status="blocked" with the reason. The PM sees that count and your reason.`
  );
}

const REMAINDER_NOTE = 'Remainder named at close:';

/** The note a close that named its remainder leaves on the task's record, once it has landed. */
export function namedRemainderNote(taskId: string, agentId: string, args: Record<string, unknown>): string | null {
  const f = closeFacts(taskId);
  const rem = f ? namedRemainder(taskId, agentId, `${f.left} ${f.measure.unit}`, args) : null;
  return f && rem ? `${REMAINDER_NOTE} ${f.left} ${f.measure.unit} ${rem.disposition}: ${rem.reason}` : null;
}

/** Did a close on this task name its remainder (the note above is on its record)? */
export function remainderOnRecord(taskId: string): boolean {
  return readAuditTrail(taskId, { kinds: ['observation'] }).some((e) => (e.note ?? '').startsWith(REMAINDER_NOTE));
}

export function recordNamedRemainder(agentId: string, taskId: string, note: string): void {
  writeTaskLog({ taskId, fromEntity: `agent:${agentId}`, entryKind: 'observation', note });
}

/** The project's open measured tasks: what close_project(status="complete") would close and must judge. */
export function measuredOpenTasksOf(projectId: string): Array<{ id: string; title: string }> {
  return getDb().prepare(
    `SELECT id, title FROM work WHERE parent_id = ? AND kind = 'task' AND measure_json IS NOT NULL
       AND state NOT IN ('done', 'failed', 'abandoned')`,
  ).all(projectId) as Array<{ id: string; title: string }>;
}

/** close_project(status="complete"): the same judgement over every measured task it would close.
 *  A project close cannot name a remainder for each task, so it names the door that can. */
export function projectRemainderGate(projectId: string): string | null {
  const left = measuredOpenTasksOf(projectId)
    .map((t) => ({ t, f: closeFacts(t.id) }))
    .filter((x): x is { t: { id: string; title: string }; f: NonNullable<ReturnType<typeof closeFacts>> } => x.f !== null);
  if (left.length === 0) return null;
  const lines = left.map(({ t, f }) => `"${t.title}" (${t.id.slice(0, 8)}): its measure (${describeMeasure(f.measure)}) still returns ${f.left} ${f.measure.unit}`);
  return (
    `Refused: close_project(status="complete") on a project with measured work left. ${lines.join('; ')}. ` +
    `Those tasks are not done. Continue working through what each measure lists; if the rest of one genuinely cannot or should not be done, ` +
    `close that task with work_update(action="status", status="complete", remainder={disposition:"skipped", reason:"<why>"}) or status="blocked", then close the project.`
  );
}
