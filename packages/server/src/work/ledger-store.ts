// v3.5 DONE IS MEASURED: the SQL for a task's ledger (`work_ledger`, migration 200) and for the
// engine's readings of its measure. Lives under work/ because every write to the spine does
// (work/__tests__/single-writer-conformance.test.ts).
//
// The ledger is written by the engine from the agent's successful mutation calls
// (agent/v2/steps/execute/tracker-counting.ts, beside the effort charge), never by the model.
// One row per (task, item): a re-touch moves `last_at`, so COUNT(*) is "distinct items touched".
import { getDb } from '../db/connection.js';
import { itemKeysOf } from '../tools/item-keys.js';
import { appendWorkEvent } from './store.js';
import type { WorkEventKind } from './event-kinds.js';
import type { Measure, MeasureCount } from './measure.js';

/** One reading of a task's measure, on the task's own spine. Written by the engine (`'engine'`),
 *  so a reading is a record and never reads as the task moving (`taskMovedAtSql`). */
export const MEASURED_EVENT = 'measured' as const satisfies WorkEventKind;

/** Record the items a call touched for a task. Returns the rows inserted or touched. */
export function recordTouched(workId: string, tool: string, keys: string[], at: number = Date.now()): number {
  if (keys.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_id, item_key) DO UPDATE SET last_at = excluded.last_at, tool = excluded.tool`,
  );
  db.transaction((ks: string[]) => { for (const k of ks) stmt.run(workId, k, tool, at, at); })(keys);
  return keys.length;
}

export function ledgerTotals(workId: string): { touched: number; lastAt: number | null; byTool: Array<{ tool: string; n: number }> } {
  const db = getDb();
  const t = db.prepare('SELECT COUNT(*) AS n, MAX(last_at) AS last FROM work_ledger WHERE work_id = ?').get(workId) as { n: number; last: number | null };
  const byTool = db.prepare('SELECT tool, COUNT(*) AS n FROM work_ledger WHERE work_id = ? GROUP BY tool ORDER BY n DESC, tool').all(workId) as Array<{ tool: string; n: number }>;
  return { touched: t.n, lastAt: t.last, byTool };
}

/** One of THIS round's tool results, as the executor hands them to the count (`turnToolResults`). */
export interface RoundResult { toolCallId: string; isError: boolean; errorCode?: string }

/** Did this round's result for the call succeed? Its own flags, never its words (see below). */
export const succeededIn = (roundResults: ReadonlyArray<RoundResult>) => (call: { id?: string }): boolean => {
  const r = roundResults.find((x) => x.toolCallId === call.id);
  return !!r && !r.isError && !r.errorCode;
};

/** The ledger charge for one round's calls (agent/v2/steps/execute/tracker-counting.ts, beside the
 *  effort charge, to the same task): the items each call touched, ONLY when this round holds that
 *  call's result and it succeeded. Success is the result's own flags (`isError`, a structural
 *  `errorCode`), never its words: a refusal reads "Refused: …" as often as "Error: …". */
export function recordCallsTouched(
  workId: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  roundResults: ReadonlyArray<RoundResult>,
): void {
  const ok = succeededIn(roundResults);
  for (const tc of calls) {
    if (!ok(tc)) continue;
    const keys = itemKeysOf(tc.name, tc.arguments ?? {});
    if (keys.length > 0) recordTouched(workId, tc.name, keys);
  }
}

/** Distinct items touched (or re-touched) after `sinceMs`. */
export function ledgerTouchedSince(workId: string, sinceMs: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND last_at > ?').get(workId, sinceMs) as { n: number }).n;
}

/** v3.5 D1: items this task touched for the FIRST time after `sinceMs`. The turn end's momentum reads
 *  this, not `ledgerTouchedSince`: re-touching what the task already touched is not progress, so a
 *  loop over the same items cannot keep a job continuing (`post-call-classify/job-continues.ts`). */
export function ledgerNewItemsSince(workId: string, sinceMs: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND first_at > ?').get(workId, sinceMs) as { n: number }).n;
}

/** Store a reading of the task's measure. `remaining` null = the measure could not be read at `at`;
 *  `initial` is given only when the measure is set (a new measure is a new scope). */
export function writeMeasured(workId: string, remaining: number | null, at: number, initial?: number): void {
  getDb().prepare(
    'UPDATE work SET measure_remaining = ?, measure_at = ?, measure_initial = COALESCE(?, measure_initial) WHERE id = ?',
  ).run(remaining, at, initial ?? null, workId);
}

/** A measure is SET on a task (open, or an edit: a new measure is a new scope), with its first reading. */
export function setMeasure(workId: string, measure: Measure, count: MeasureCount, at: number): void {
  const n = count.ok ? count.count : null;
  getDb().prepare(
    'UPDATE work SET measure_json = ?, measure_initial = ?, measure_remaining = ?, measure_at = ? WHERE id = ?',
  ).run(JSON.stringify(measure), n, n, at, workId);
  appendMeasured(workId, count, n, at);
}

/** A task's measure was re-read. `remaining` null on the row = it could not be read at `at`. The
 *  first successful reading of a measure that could not be read when it was set becomes its start.
 *  `opts.keepStoredOnFailure` (the turn end's re-count, `post-call-classify/job-turn-end.ts`): a
 *  failed reading is still said on the record, but the row keeps the reading it held — the job and
 *  the close gate read that row, and one failed sweep must not end the job or free a close. The
 *  close door's re-read never passes it: NULL there is the ruling (an outage never refuses a close). */
export function recordMeasured(
  workId: string, count: MeasureCount, at: number, opts?: { keepStoredOnFailure?: boolean },
): void {
  const row = getDb().prepare('SELECT measure_initial FROM work WHERE id = ?').get(workId) as { measure_initial: number | null } | undefined;
  const initial = row?.measure_initial ?? (count.ok ? count.count : null);
  if (count.ok || !opts?.keepStoredOnFailure) writeMeasured(workId, count.ok ? count.count : null, at, initial ?? undefined);
  appendMeasured(workId, count, initial, at);
}

function appendMeasured(workId: string, count: MeasureCount, initial: number | null, at: number): void {
  appendWorkEvent(workId, MEASURED_EVENT, 'engine', count.ok
    ? { remaining: count.count, initial, at, ok: true }
    : { remaining: null, initial, at, ok: false, error: count.error }, at);
}
