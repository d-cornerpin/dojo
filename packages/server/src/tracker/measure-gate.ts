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

/** The remainder this close names, when it names one properly: `skipped` or `blocked`, with a reason. */
function namedRemainder(args: Record<string, unknown>): { disposition: string; reason: string } | null {
  const rem = args.remainder as { disposition?: unknown; reason?: unknown } | undefined;
  const reason = typeof rem?.reason === 'string' ? rem.reason.trim() : '';
  return (rem?.disposition === 'skipped' || rem?.disposition === 'blocked') && reason.length >= MIN_REMAINDER_REASON_LEN
    ? { disposition: rem.disposition, reason } : null;
}

/**
 * THE remainder judgement, the one function every door that marks a task complete asks (fix round 1,
 * orchestrator ruling): items left and not named are refused. Null = the close may proceed. It writes
 * nothing; a named remainder is recorded by the door once the close has landed (`namedRemainderNote`).
 * `takesRemainder` is false at a door that has no `remainder` argument (the schedule door), whose
 * refusal therefore names the door that does.
 */
export function remainderGate(agentId: string, taskId: string, args: Record<string, unknown>, door = 'status="complete"', takesRemainder = true): string | null {
  const f = closeFacts(taskId);
  if (!f || (takesRemainder && namedRemainder(args))) return null;
  const { unit } = f.measure;
  const named = `remainder={disposition:"skipped", reason:"<why these ${f.left} are left>"}`;
  return (
    `Refused: ${door} on a measured task. Its measure (${describeMeasure(f.measure)}) still returns ${f.left} ${unit} ` +
    `(${f.initial ?? '?'} when the task started; ${ledgerTotals(taskId).touched} touched so far). The task is not done. ` +
    `Continue working through what the measure lists. If the rest genuinely cannot or should not be done, say which and why: ` +
    (takesRemainder
      ? `status="blocked" with the reason, or close again with ${named}; the PM sees that count and your reason.`
      : `status="blocked" with the reason, or close it with work_update(action="status", status="complete", ${named}); the PM sees that count and your reason.`)
  );
}

/** The note a close that named its remainder leaves on the task's record, once it has landed. */
export function namedRemainderNote(taskId: string, args: Record<string, unknown>): string | null {
  const f = closeFacts(taskId);
  const rem = f ? namedRemainder(args) : null;
  return f && rem ? `Remainder named at close: ${f.left} ${f.measure.unit} ${rem.disposition} — ${rem.reason}` : null;
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
