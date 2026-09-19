// SLOW-INFERENCE T79c — the durable per-task effort meter's WRITE LAYER.
//
// This file exists because of a rule this codebase already enforces on itself
// (`work/__tests__/single-writer-conformance.test.ts`, PART A clause (a)): every write to
// `work` / `work_events` / `adjudications` lives under `work/`, full stop — the RULE is
// about where the SQL TEXT lives, not about who calls it. `tracker/effort-governor.ts` is
// the module the brief and both call sites (`agent/v2/steps/execute/tracker-counting.ts`,
// `work/tracker-store.ts:setTrackerStatus`) actually import — declared constant, delta
// arithmetic, and the two public write functions — but the two literal `UPDATE work`
// statements themselves have to live here.
//
// Nothing else is here on purpose: no threshold, no policy, no "when should this fire"
// judgement — see `tracker/effort-governor.ts` for all of that. This file is the two
// UPDATE statements and nothing they don't need to be trusted to do.

import { getDb } from '../db/connection.js';

/** Add `calls` to a task's monotonic effort total. The caller (`chargeEffort`) has already
 *  refused non-positive values, so this file trusts its one caller and does not re-check. */
export function writeEffortCharge(taskId: string, calls: number): void {
  getDb()
    .prepare('UPDATE work SET effort_calls = effort_calls + ? WHERE id = ?')
    .run(calls, taskId);
}

/** Move the baseline to the task's CURRENT monotonic total — the meter reads 0 again, and
 *  the lifetime total is untouched (advancement moves the baseline; it never erases
 *  history). The caller (`advanceBaseline`) is responsible for calling this ONLY on a
 *  genuine advance (a `transition()` result of `kind: 'applied'`), never on a refusal and
 *  never on G4's "already in that state" no-op. */
export function writeEffortBaseline(taskId: string): void {
  getDb()
    .prepare('UPDATE work SET effort_reviewed_calls = effort_calls WHERE id = ?')
    .run(taskId);
}
