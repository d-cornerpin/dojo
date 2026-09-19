// SLOW-INFERENCE T79c — THE DURABLE EFFORT METER (wide loops accumulate what honest
// work doesn't).
//
// A wide loop's signature is effort-without-advancement, and until now nothing counted
// it anywhere a compaction could not erase: `agent/turn-state.ts`'s cross-turn maps are
// per-process, in memory, gone the moment a context compacts or the process restarts.
// `migrations/165_work_effort_meter.sql` puts the counter on the task row itself — see
// that file's header for the full argument (column placement, why two columns, why
// DEFAULT 0 is safe on a lived-in database, why no CHECK).
//
// THIS MODULE IS A LEAF, ON PURPOSE — relative to the two sides that both need it. It
// imports nothing from `tracker/pm-agent.ts` or `agent/v2/loop.ts`, so neither side
// importing this module creates a cycle:
//   * the CHARGE site (`agent/v2/steps/execute/tracker-counting.ts`) is inside the v2
//     loop, counting this iteration's work calls.
//   * the ADVANCE site (`work/tracker-store.ts:setTrackerStatus`, "the tracker's one
//     status writer") is inside the tracker's write layer, moving the baseline the
//     instant a task genuinely transitions.
// It does import `work/effort-meter.ts` for the two literal `UPDATE work` statements —
// not a cycle (that module imports only the DB connection), and not optional: the work
// spine's own single-writer conformance walk
// (`work/__tests__/single-writer-conformance.test.ts`, PART A clause (a)) requires every
// write to `work` to live under `work/`, so the SQL text itself cannot live here. This
// module stays the one the brief names and both call sites import — the declared
// constant, the delta arithmetic, and the two public write functions — it just hands the
// actual UPDATE off to the module the tree requires it to live in.
//
// CALLS ONLY, v1 (YAGNI, recorded so nobody "helpfully" widens this later): token
// attribution has no existing seam to ride, unlike calls (already counted at
// `tracker-counting.ts`'s RC-19 cross-turn accumulator). It is not built until a
// measured need names it.

import { writeEffortCharge, writeEffortBaseline } from '../work/effort-meter.js';

/**
 * The delta threshold T79d (not this module) reads to decide a task has burned enough
 * effort since its last real advancement to warrant intervention. Declared HERE, with
 * one owner, because a second copy of this number anywhere else is the exact drift this
 * plan's other migrations (163, 164) already refused to create for their own constants.
 */
export const EFFORT_REVIEW_DELTA_CALLS = 150;

/**
 * Charge `calls` counted work calls to a task's monotonic effort total. Called once per
 * iteration, from `tracker-counting.ts`, for the agent's current claimed task (its own
 * resolution of "current claimed task" mirrors the engine's existing tracker-floors nag
 * in shape; see that call site's comment for why).
 *
 * `calls <= 0` is a no-op: nothing was done, so nothing is charged, and it saves a write
 * on the (common) turns where this iteration's non-tracker count is zero.
 */
export function chargeEffort(taskId: string, calls: number): void {
  if (calls <= 0) return;
  writeEffortCharge(taskId, calls);
}

/**
 * The meter itself: how much effort has landed on this task SINCE it last genuinely
 * advanced. A plain subtraction, not a query — callers that already have the two
 * columns (a `listTasks`/`getTask` row extended with them, or a hand-picked SELECT)
 * pass them straight in, so this survives anything that wiped IN-MEMORY state (the
 * compaction this whole plan exists to route around) as long as the two columns
 * themselves were read from the database.
 */
export function effortDelta(row: { effort_calls: number; effort_reviewed_calls: number }): number {
  return row.effort_calls - row.effort_reviewed_calls;
}

/**
 * Move the baseline to the task's CURRENT monotonic total — the meter reads 0 again,
 * and the lifetime total in `effort_calls` is untouched (advancement moves the
 * baseline; it never erases history).
 *
 * Called from exactly one place, `work/tracker-store.ts:setTrackerStatus`, and only
 * when that call's own `transition()` result is `kind: 'applied'` — a genuine state
 * move, never a refusal and never G4's "already in that state" no-op. That guard is
 * what makes a looping agent's same-status spam ("the [NO-OP] adversarial case")
 * unable to reset its own meter: this function is simply never reached for a call
 * that did not move the row.
 */
export function advanceBaseline(taskId: string): void {
  writeEffortBaseline(taskId);
}
