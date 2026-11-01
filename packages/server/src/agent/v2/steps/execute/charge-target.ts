// ════════════════════════════════════════
// WHICH TASK PAYS FOR THIS ITERATION'S CALLS — split out of tracker-counting.ts (accounting) by
// responsibility: the pick of the charge target, with its incidents.
// ════════════════════════════════════════

import { getDb } from '../../../../db/connection.js';
import { taskScope } from '../../../../work/tracker-view.js';
import { jobTaskOf } from '../post-call-classify/job-turn-end.js';

/**
 * T79c: resolve "the agent's CURRENT claimed task" for the durable effort meter.
 *
 * Same scope, same predicate, same filter as `tracker-floors.ts`'s own nag — it
 * resolves "the only open tracker task assigned to you" (the "hasn't been updated in
 * a while" message, ~line 283 there) via `taskScope`, `state = 'claimed'` (status
 * "in_progress"), `agent_id = ?`. Copied in SHAPE rather than by calling that code,
 * because the nag's question is "is there a stale one to name in a message" (it reads
 * every claimed task and picks the STALEST to warn about) and this one is "which row
 * pays for THIS call" — a different question that additionally needs a deterministic
 * pick when more than one task is claimed at once: charge the MOST RECENTLY UPDATED
 * one (`ORDER BY updated_at DESC, rowid DESC LIMIT 1`). That is also the task most
 * likely to be the one this iteration's calls were actually for, since a tracker
 * write on it is what would have bumped `updated_at` in the first place.
 *
 * T79 FIX WAVE, FINDING 3 (minor): `, rowid DESC` is the tiebreak. `noteEngineCheckpoint`
 * (`work/engine-checkpoint-note.ts`) touches every one of an agent's claimed tasks with ONE
 * shared `now` at a checkpoint, so two tasks can share the exact same `updated_at` — without a
 * secondary sort the pick between them is whatever order SQLite happens to return, unspecified
 * and untested. `rowid` is monotonic insertion order, always present on this table (a normal
 * rowid table, not `WITHOUT ROWID`), and free of ties by construction.
 *
 * Returns `null` when nothing is claimed — charge nothing in that case. Untracked
 * work already has its own governor (the tracker floors: the >3 nudge / >=6
 * auto-scaffold above/below in this same iteration), a SEPARATE mechanism from this
 * durable per-task meter.
 *
 * Exported so the "most-recently-updated wins" choice is directly testable in
 * isolation from the rest of this iteration's accounting.
 */
export function resolveCurrentClaimedTaskId(agentId: string): string | null {
  const row = getDb().prepare(
    `SELECT w.id AS id FROM work w
     WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'
     ORDER BY w.updated_at DESC, w.rowid DESC LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * t362: which task THIS iteration's items are charged to — the SAME task the turn end
 * reads, not just the most recently updated claim.
 *
 * `job-turn-end.ts`'s `jobTaskOf` answers "the agent's task" for the turn end — and on the
 * run the park's own wake started it restricts the pick to the job's carried ids. An agent
 * that opens a second (more recently updated) task during a continued turn used to have
 * every labelled item charged to that second task while the turn end kept reading the job's
 * own task: `ledgerNewItemsSince` / `novelCallsInTurn` read 0 there, momentum came out false,
 * and `continueTheJob` recorded `stalled` for a job that did all its work. So the charge
 * site asks `jobTaskOf` first and only falls back to `resolveCurrentClaimedTaskId` when it
 * gives nothing — a run that is not the continuation, or a job carrying no open claimed
 * task, keeps the old pick.
 *
 * Exported so the two disagreeing picks are directly testable in isolation
 * (`the-job-task-is-the-one-charged.test.ts`).
 */
export function taskToCharge(agentId: string): string | null {
  return jobTaskOf(agentId, getDb())?.id ?? resolveCurrentClaimedTaskId(agentId);
}
