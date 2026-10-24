// v3.5 D1, FIX ROUND 2 (ruling 3) — WHAT THE PM'S CHECK-IN LADDER KNOWS ABOUT A CONTINUED JOB.
//
// The ladder holds for the job in flight (the agent's carry) and while the agent is mid-turn. A
// measured job the engine keeps continuing (`agent/v2/steps/post-call-classify/job-continues.ts`) is
// almost always one or the other, so a chain of continuations that touches no item, only ever making
// new reads, would never be checked in on. The hold stands for such a job only while it is touching
// items; one that is not lets the ladder run on its existing rungs, and the check-in carries the fact.
import { getDb } from '../db/connection.js';
import { ledgerNewItemsSince } from '../work/ledger-store.js';
import { lastTurnEnd } from '../work/job-momentum.js';

/** Is this a measured job the engine has been continuing that touched NO new item since `sinceMs`
 *  (the last check-in, or before the first, the start of the first rung's own window)? */
export function continuedJobTouchingNothing(taskId: string, sinceMs: number): boolean {
  const row = getDb().prepare('SELECT measure_json FROM work WHERE id = ?').get(taskId) as { measure_json: string | null } | undefined;
  if (!row?.measure_json || lastTurnEnd(taskId)?.kind !== 'continued') return false;
  return ledgerNewItemsSince(taskId, sinceMs) === 0;
}

/** The fact the check-in carries: continuations since the job last touched an item, and what is left. */
export function continuedJobFact(taskId: string): string | null {
  const db = getDb();
  const lastItem = (db.prepare('SELECT MAX(first_at) AS at FROM work_ledger WHERE work_id = ?').get(taskId) as { at: number | null }).at ?? 0;
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'continued' AND created_at > ?`).get(taskId, lastItem) as { n: number }).n;
  if (n === 0) return null;
  const left = (db.prepare('SELECT measure_remaining AS r FROM work WHERE id = ?').get(taskId) as { r: number | null } | undefined)?.r ?? null;
  const times = n === 1 ? '1 time' : `${n} times`;
  return `Continued ${times} since it last touched an item${left === null ? '' : `; ${left.toLocaleString('en-US')} left on its measure`}.`;
}

/** v3.5 text wave (Part C5, t250 fix round 3 NB2): the fact a check-in carries for a MEASURED task with
 *  items left, or null (unmeasured, never read, or reading 0). */
export function measuredLeftFact(taskId: string): string | null {
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null } | undefined;
  if (!row?.measure_json || row.measure_remaining === null || row.measure_remaining <= 0) return null;
  let m: { tool?: unknown; args?: { query?: unknown }; unit?: unknown };
  try { m = JSON.parse(row.measure_json) as typeof m; } catch { return null; }
  if (typeof m.tool !== 'string' || typeof m.args?.query !== 'string') return null;
  const start = row.measure_initial === null ? '' : ` (of ${row.measure_initial.toLocaleString('en-US')} at the start)`;
  // The words of `work/measure.ts describeMeasure`, read off the stored row. Importing the registry here (into
  // the PM's module graph) stopped the measured-close suites' counter seam from being reached, so it is not imported.
  return `Its measure (${m.tool} "${m.args.query}") still returns ${row.measure_remaining.toLocaleString('en-US')} ${typeof m.unit === 'string' ? m.unit : 'items'}${start}.`;
}
