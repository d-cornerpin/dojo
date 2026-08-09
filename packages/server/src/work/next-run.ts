// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE WRITER OF THE SCHEDULE'S FIRE TIME — SWEEP-F T2, via SWEEP CORE-2 item 3.
//
// ── WHAT THIS REPLACES, RE-DERIVED AT HEAD RATHER THAN INHERITED (#14) ──────────────────
// T2's bullet says "single `next_run_at` writer (`transition()` — tracker's second writer
// dies)". The second writer it names WAS ALREADY DEAD when this task ran: `tracker/tools.ts`
// carries zero `UPDATE`/`INSERT` statements at this commit — PHASE-2 T8c2/T10F folded them
// onto the spine — so that clause is VERIFIED, not rebuilt. What the census found instead is
// the shape the plan could not see from where it was written:
//
//   `next_run_at` was one of FORTY-FIVE columns in `TrackerAttr`, the generic attribute
//   union `patchWork` accepts. FOURTEEN call sites across four modules reached the column
//   through that door, each with its own idea of which other schedule columns had to move
//   with it, and the union gave the compiler no way to tell a caller that it was writing the
//   platform's firing clock rather than a title. A column any of forty-five-wide patch can
//   set is not owned by anybody.
//
// So the fix is the one `transition()` already applies to `work.state`: the column leaves the
// generic union — a caller that names it now fails to COMPILE — and lands here, behind doors
// that each say what they are for and each demand a reason.
//
// ── THE FOUR DOORS, AND WHY THERE ARE FOUR RATHER THAN ONE ─────────────────────────────
//   setNextRun               unconditional write. Every ordinary path: create, edit, resume,
//                            recover, advance-at-close, defer.
//   clearLiveSchedule        the CAS that disarms a live schedule (was `stopLiveSchedule` in
//                            `tracker-store.ts`). Its `schedule_status IN ('waiting','running')`
//                            predicate IS the race token `terminateLiveScheduleOnFallen` reads.
//   advanceScheduleOnClaim   the fire-time advance, as a STATEMENT rather than a transaction,
//   restoreScheduleOnRelease because `claimOccurrence`/`releaseOccurrence` must run it inside
//                            the same `withUnit` as the occurrence row's INSERT/DELETE. A
//                            door that opened its own transaction would break the CAS the
//                            whole occurrence design rests on; a door that could not be called
//                            from inside one would have left the statement where it was.
//
// ── THE ONE COMPUTER, AND THE TWO VALUES THAT DO NOT COME FROM IT ──────────────────────
// Every instant written through these doors comes from `scheduler/engine.ts:calculateNextRun`
// — the tree's only recurrence walker — with exactly two declared exceptions, both of which
// re-fire the SAME occurrence rather than advancing the cadence:
//
//   1. THE DEPENDENCY DEFER (`scheduler/runner.ts`, `checkScheduledTasks`): a task whose
//      `depends_on` is unmet is pushed `Date.now() + 30_000` so the tick re-checks it soon.
//      It writes an explicit instant rather than `datetime('now','+30 seconds')` because
//      SQLite's space-separated form sorts BELOW the 'T' of an ISO `now`, which made the
//      defer collapse to "due again next tick".
//   2. RUN_NOW / CATCH-UP (`tracker/tools.ts`, `trackerResolveMissedRuns(action='run_now')`):
//      the owner asked for one catch-up run, so the fire time is NOW by request. The natural
//      anchor is recomputed by `onTaskRunComplete` after that run closes.
//
// Both are re-asserted by `scheduler/__tests__/scheduler-owns-its-clock.test.ts` (A4).
//
// ── WHY THE ASSIGNMENT MACHINERY IS BUILT HERE AND NOT BORROWED FROM patchWork ─────────
// Because borrowing it is the defect. `patchWork` is the generic door; if this module called
// it, `next_run_at` would still be reachable through a forty-five-column union and the census
// in A3 would be enforcing a rule with a hole in it. `db/patch.ts:patchAssignments` — the ONE
// RULE that `undefined` leaves a column alone and `null` clears it — is shared, because that
// rule is not the door.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { patchAssignments } from '../db/patch.js';
import { createLogger } from '../logger.js';
import { noSuchWorkDetail, type WorkPatchOutcome } from './outcome.js';
import type { WorkPatch } from './tracker-store.js';

const logger = createLogger('next-run');

/**
 * The columns that may ride in the SAME statement as a fire-time write.
 *
 * They are not a convenience: `next_run_at` and `schedule_status` describe ONE event — "this
 * run finished and the next one is due at T" — and split across two statements they can
 * disagree, which is the "sleeping project" class PHASE-2 closed from the other side. The
 * union is `WorkPatch` minus the column this module owns, so the type system enforces that a
 * caller cannot smuggle `next_run_at` in twice.
 */
export type ScheduleCompanions = WorkPatch;

export interface NextRunWrite {
  /** The instant the next occurrence is due, epoch-ms. `null` disarms the schedule. */
  readonly at: number | null;
  /** Schedule columns describing the same event; they land in the same UPDATE. */
  readonly alongside?: ScheduleCompanions;
  /** WHY the fire time moved. Required — the column may not move anonymously. */
  readonly reason: string;
  /**
   * `false` leaves `updated_at` alone. ONE caller passes it — the dependency defer — because
   * the PM ladder reads `updated_at` as "when did this work last MOVE", and re-checking a
   * blocked dependency in thirty seconds is not a move. Carried verbatim from the
   * `patchWork(..., { touch: false })` it replaces.
   */
  readonly touch?: boolean;
}

/** The attribute door's stale-id refusal, in this module's own voice but the shared sentence. */
function refuseNoSuchWork(id: string): WorkPatchOutcome {
  return { kind: 'refused', workId: id, reason: 'no-such-work', detail: noSuchWorkDetail(id) };
}

/**
 * Write a schedule's next fire time, with whatever schedule columns move with it.
 *
 * Returns the same `WorkPatchOutcome` union `patchWork` returns, so every call site keeps its
 * `noteUnsettled(...)` wrapper and the unsettled-write ledger sees fire-time writes exactly as
 * it saw them before.
 */
export function setNextRun(workId: string, write: NextRunWrite): WorkPatchOutcome {
  const { sets, values } = patchAssignments({ ...(write.alongside ?? {}), next_run_at: write.at });
  if (write.touch !== false) {
    sets.push('updated_at = ?');
    values.push(Date.now());
  }
  values.push(workId);
  const changes = getDb()
    .prepare(`UPDATE work SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
  if (changes === 0) return refuseNoSuchWork(workId);
  logger.debug('next run written', { workId, at: write.at, reason: write.reason });
  return { kind: 'applied', value: changes };
}

/**
 * Disarm a schedule that can still fire, and report whether THIS caller is the one that did it.
 *
 * Moved verbatim from `work/tracker-store.ts:stopLiveSchedule` (PHASE-2 T8c2's shape, unchanged
 * SQL). Only 'waiting' (armed) and 'running' (a run in flight) can still fire; the predicate is
 * the race token `terminateLiveScheduleOnFallen` reads to decide whether it may go on to skip
 * the open occurrences and tell the owner about a dropped reminder.
 */
export function clearLiveSchedule(workId: string): boolean {
  const r = getDb().prepare(`
    UPDATE work
       SET schedule_status = 'completed', is_paused = 1, next_run_at = NULL, updated_at = ?
     WHERE id = ? AND schedule_status IN ('waiting', 'running')
  `).run(Date.now(), workId);
  return r.changes === 1;
}

/**
 * The fire-time advance, as a single guarded statement.
 *
 * ⚠ Runs INSIDE the caller's transaction and opens none of its own — `claimOccurrence` needs
 * this UPDATE and the occurrence-row INSERT to succeed or roll back together, and a `.changes`
 * other than 1 is how it learns it lost the CAS. The guard clauses are carried byte-for-byte
 * from the statement this replaces: the schedule must still be waiting, unpaused, and still
 * pointing at THIS occurrence, compared against the RAW epoch-ms column (the display text
 * drops milliseconds and made the CAS unwinnable for any schedule started from a real clock).
 */
export function advanceScheduleOnClaim(db: Database.Database, input: {
  workId: string; nowMs: number; nextRunMs: number | null; occurrenceMs: number | null;
}): number {
  return db.prepare(`
    UPDATE work
       SET schedule_status = 'running', last_run_at = ?, next_run_at = ?, updated_at = ?
     WHERE id = ? AND schedule_status = 'waiting' AND is_paused = 0
       AND next_run_at = ? AND next_run_at <= ?
  `).run(input.nowMs, input.nextRunMs, input.nowMs, input.workId,
         input.occurrenceMs, input.nowMs).changes;
}

/**
 * Put the released occurrence back on the schedule.
 *
 * ⚠ Also runs inside the caller's transaction, for the same reason: `releaseOccurrence` deletes
 * the occurrence row and restores the schedule in one unit. Both instants are the RAW columns —
 * restoring a truncated `last_run_at` would silently shift it by up to 999 ms every time a group
 * was momentarily empty.
 */
export function restoreScheduleOnRelease(db: Database.Database, input: {
  workId: string; occurrenceMs: number | null; priorLastRunMs: number | null;
}): void {
  db.prepare(`
    UPDATE work SET schedule_status = 'waiting', next_run_at = ?, last_run_at = ?, updated_at = ?
     WHERE id = ?
  `).run(input.occurrenceMs, input.priorLastRunMs, Date.now(), input.workId);
}
