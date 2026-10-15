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

/** Add `calls` to a task's monotonic effort total, and move the baseline forward by the `novel`
 *  of them (t172: a call that is not a repeat is progress, so it is accounted for at once and the
 *  meter `effort_calls - effort_reviewed_calls` rises only by the REPEATS). `novel` is 0 for the
 *  legacy whole-number charge. The caller (`chargeEffort`/`chargeEffortCalls`) has already refused
 *  non-positive values and guarantees `novel <= calls`, so this file trusts its callers and does not
 *  re-check; the one statement keeps `effort_reviewed_calls <= effort_calls` by construction. */
export function writeEffortCharge(taskId: string, calls: number, novel = 0): void {
  getDb()
    .prepare('UPDATE work SET effort_calls = effort_calls + ?, effort_reviewed_calls = effort_reviewed_calls + ? WHERE id = ?')
    .run(calls, novel, taskId);
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
