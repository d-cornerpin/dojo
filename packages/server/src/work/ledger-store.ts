// v3.5 DONE IS MEASURED: the SQL for a task's ledger (`work_ledger`, migration 200) and for the
// engine's readings of its measure. Lives under work/ because every write to the spine does
// (work/__tests__/single-writer-conformance.test.ts).
//
// The ledger is written by the engine from the agent's successful mutation calls
// (agent/v2/steps/execute/tracker-counting.ts, beside the effort charge), never by the model.
// One row per (task, item): a re-touch moves `last_at`, so COUNT(*) is "distinct items touched".
import { getDb } from '../db/connection.js';
import { itemKeysOf } from '../tools/item-keys.js';

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

/** The ledger charge for one iteration's calls (agent/v2/steps/execute/tracker-counting.ts, beside
 *  the effort charge, to the same task): the items each SUCCESSFUL call touched. Errors touch nothing. */
export function recordCallsTouched(
  workId: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  results: ReadonlyArray<{ toolCallId: string; isError: boolean }>,
): void {
  for (const tc of calls) {
    if (results.some((tr) => tr.toolCallId === tc.id && tr.isError)) continue;
    const keys = itemKeysOf(tc.name, tc.arguments ?? {});
    if (keys.length > 0) recordTouched(workId, tc.name, keys);
  }
}

/** Distinct items touched (or re-touched) after `sinceMs`. */
export function ledgerTouchedSince(workId: string, sinceMs: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND last_at > ?').get(workId, sinceMs) as { n: number }).n;
}

/** Store a reading of the task's measure. `remaining` null = the measure could not be read at `at`;
 *  `initial` is given only when the measure is set (a new measure is a new scope). */
export function writeMeasured(workId: string, remaining: number | null, at: number, initial?: number): void {
  getDb().prepare(
    'UPDATE work SET measure_remaining = ?, measure_at = ?, measure_initial = COALESCE(?, measure_initial) WHERE id = ?',
  ).run(remaining, at, initial ?? null, workId);
}

