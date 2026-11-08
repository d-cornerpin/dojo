// PHASE-2 T8c2 item 4 — AN OCCURRENCE IS A WORK ROW, AND FIRING ONE IS A CLAIM.
//
// WHAT THIS REPLACES, and why the replacement is a different SHAPE rather than a repair.
//
// D21's exactly-once guarantee was one UPDATE keyed on a timestamp:
//
//     UPDATE work SET schedule_status='running', ... WHERE id=? AND next_run_at = ?
//
// Two things were wrong with keying it on the clock, and only the second one was visible:
//
//   1. IT WAS A PLEA, NOT A CONSTRAINT. "Execute this occurrence once" was a property of
//      whichever process happened to win an UPDATE. Nothing in the schema said an occurrence
//      exists at most once, so nothing could refuse a second one. Research 19 s1c's answer is
//      `UNIQUE(schedule_id, sequence)`, and T2 already put it in the DDL as
//      `ux_work_occurrence ON work(parent_id, sequence) WHERE kind='occurrence'` — an index
//      with nothing to bite on, because nobody had ever written an occurrence row.
//
//   2. THE CLOCK IT COMPARED HAD BEEN TRUNCATED ON THE WAY OUT. The scheduler's due-scan
//      projects `next_run_at` through `tracker-view.ts:msToText`, which is
//      `strftime('%Y-%m-%d %H:%M:%S', col/1000, 'unixepoch')` and drops milliseconds BY
//      CONSTRUCTION. The runner then converted that text back with `tsToMs` and handed it to
//      the CAS. Stored 1785316028089, compared 1785316028000, zero rows changed, and the
//      server logged "1 task(s) due" followed by "occurrence already claimed elsewhere"
//      forever, with `task_runs` empty and the row untouched. It reads as a benign race and
//      is permanent. Model-set reminders land on whole seconds, which is why the defect hid:
//      anything scheduled from a real clock reading is dark. (Bisected at PHASE-2 T8V; the
//      full write-up is in DOJO-ISSUES-LOG.md.)
//
// The fix for (2) is NOT a rounder comparison. It is that the claim stops asking the clock a
// question it cannot answer precisely: **the claim is the INSERT of the occurrence row**, and
// `ux_work_occurrence` is what refuses the second one. The schedule's own precondition (still
// waiting, not paused, still pointing at this occurrence) is checked in the same transaction
// against the RAW epoch-ms column, which the due-scan now projects beside the display text.
// Same lesson item 1 learned inside its own module and wrote down — WHEN A SEQUENCE EXISTS,
// DO NOT COMPARE A CLOCK — where a remediation and the next poke shared a millisecond and the
// ladder sat on rung 0 forever. There the boundary became `work_events.id`; here it is
// `work.sequence`.
//
// requirement preserved, each asserted in `__tests__/occurrences.test.ts`:
//   * exactly-once — two processes reading the same due row cannot both fire it;
//   * the claim token — the caller learns whether it won, and only the winner fires;
//   * advance-at-fire — the NEXT occurrence is written when this one is claimed, so a hung or
//     crashed turn can no longer stall the cadence (D21);
//   * release — a claim taken and then abandoned (no agent available in the group) restores
//     the occurrence and the prior `last_run_at` exactly as it was before the claim existed;
//   * AND THE ONE PROPERTY THE OLD SHAPE COULD NOT HAVE: a crashed fire cannot LOSE the
//     occurrence. The row is durable and stays `open`, so "which occurrence was in flight when
//     the box went down" is a query rather than an archaeology exercise.
//
// WRITER-MODULE LAW: this file lives under `work/` because it writes `work` and `work_events`
// (single-writer clause (a)). It does not write `work.state` — every close goes through
// `transition()` in `store.ts` (clause (b)).

import { runItemsLeft, recordRunRemainder, RUN_STATUS_INCOMPLETE, countOf } from './measure-close-gate.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { clearReferencesToWork } from './work-refs.js';
import { createLogger } from '../logger.js';
import type { WorkEventKind } from './event-kinds.js';
// SWEEP CORE-2 item 3 — the schedule's fire time has ONE writing module; these two statements
// are its, and are called from inside this file's transactions (see `work/next-run.ts`).
import { advanceScheduleOnClaim, restoreScheduleOnRelease } from './next-run.js';
import { transition, appendWorkEvent, type WorkOutcome } from './store.js';
import { occurrenceOwesDeliverable } from './deliverable-declaration.js';
import { proofDelivery } from './done/proof.js';

const logger = createLogger('occurrences');

/** `kind` of the rows this module owns. `store.ts:evidenceResolves` already admits a `work`
 *  row of this kind as evidence for an engine transition (G6) — the half of T2's design that
 *  has been waiting for a writer. */
export const OCCURRENCE_KIND = 'occurrence';

/** The event kinds an occurrence carries. Both sides import these so a writer and a reader
 *  cannot disagree by typo; `satisfies` (T4-SCHEMA) makes it a VIEW onto `event-kinds.ts`
 *  rather than a second declaration. This note used to say the column has no CHECK — it has
 *  one from migration `152`. */
export const OCCURRENCE_EVENT = {
  /** The claim was won and the run is being started. Payload: `{ sequence, scheduled_for }`. */
  fired: 'occurrence_fired',
  /** A won claim was handed back unfired (no agent available). Payload: `{ reason }`. */
  released: 'occurrence_released',
  /** The run closed, carrying ITS OWN outcome word. Payload: `{ run_status, summary }`.
   *  PHASE-2 T10F: the discriminator `work.state` cannot hold — see `settleOccurrence`. */
  settled: 'occurrence_settled',
} as const satisfies Record<string, WorkEventKind>;

/**
 * The occurrence a due-scan row is pointing at, in the spine's own unit.
 *
 * THE WHOLE ms-CAS DEFECT IS THIS ONE FUNCTION'S SUBJECT, so it is a named thing with one
 * owner rather than an expression repeated at each call site. It reads the RAW epoch-ms
 * column that `scheduleRowColumns` projects as `next_run_at_ms`; the `next_run_at` beside it
 * is the second-resolution TEXT the tracker's readers and the dashboard render, and it must
 * never be the input to a comparison.
 */
export function occurrenceOf(row: Record<string, unknown>): number | null {
  const raw = row.next_run_at_ms;
  return typeof raw === 'number' ? raw : null;
}

export interface ClaimInput {
  /** The scheduled work row (`kind='task'`) whose occurrence is being fired. */
  workId: string;
  /** Which occurrence: the run number this fire will be. `UNIQUE(parent_id, sequence)`. */
  sequence: number;
  /** The exact occurrence instant the due-scan read, epoch ms. */
  occurrenceMs: number | null;
  /** Now, epoch ms — the same value the due-scan filtered on. */
  nowMs: number;
  /** The NEXT occurrence, computed at fire time (D21 advance-at-fire). Null = no more runs. */
  nextRunMs: number | null;
  /** Who is firing. Rides the occurrence row's `agent_id` so a terminated-agent sweep can see it. */
  agentId: string;
}

/**
 * Claim an occurrence, atomically, and return its id — or null when this caller lost.
 *
 * Both halves land in ONE transaction, so a caller can never end up holding a row that the
 * schedule does not agree was claimed:
 *
 *   1. INSERT the occurrence row. `ux_work_occurrence` refuses a duplicate `(parent_id,
 *      sequence)`, so the SECOND process to reach here loses by constraint, not by luck.
 *   2. Advance the schedule, guarded on the preconditions the due-scan itself read: still
 *      `waiting`, not paused, still pointing at THIS occurrence. The comparison is epoch-ms
 *      against epoch-ms, both sides raw.
 *
 * Losing either half rolls back both.
 */
export function claimOccurrence(input: ClaimInput): string | null {
  const db = getDb();
  const occurrenceId = uuidv4();
  let won = false;

  try {
    withUnit(() => {
      db.prepare(`
        INSERT INTO work (
          id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
          root_kind, root_id, state, intent, wakes, closes_thread,
          title, sequence, next_run_at, opened_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'schedule', ?, 'schedule', ?, 'open', 'occurrence', 0, 0,
                  ?, ?, ?, ?, ?)
      `).run(
        occurrenceId, OCCURRENCE_KIND, input.workId, input.agentId, input.agentId,
        input.workId, input.workId,
        `occurrence #${input.sequence}`, input.sequence, input.occurrenceMs,
        input.nowMs, input.nowMs,
      );

      // SWEEP CORE-2 item 3: the fire-time advance is `work/next-run.ts`'s statement, run
      // INSIDE this unit so the claim's two halves still succeed or roll back together. The
      // SQL and every guard clause are carried byte-for-byte; only the address moved.
      const advanced = advanceScheduleOnClaim(db, {
        workId: input.workId, nowMs: input.nowMs,
        nextRunMs: input.nextRunMs, occurrenceMs: input.occurrenceMs,
      });

      // The schedule moved out from under this tick (paused, re-timed, or already claimed by
      // a process that got here first). Roll the occurrence row back with it — a claim token
      // whose schedule disagrees is not a claim.
      if (advanced !== 1) throw new LostClaim();

      appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.fired, 'scheduler', {
        sequence: input.sequence, scheduled_for: input.occurrenceMs,
      });
      won = true;
    });
  } catch (err) {
    if (err instanceof LostClaim) return null;
    // A UNIQUE violation on `ux_work_occurrence` is the OTHER way to lose, and it is the one
    // that makes "execute once" a constraint. Anything else is a real fault and is rethrown.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      logger.info('occurrence already claimed (unique constraint)', {
        workId: input.workId, sequence: input.sequence,
      });
      return null;
    }
    throw err;
  }

  return won ? occurrenceId : null;
}

class LostClaim extends Error {}

/**
 * Hand a won claim back unfired, restoring the occurrence exactly as it was.
 *
 * D21's release path, carried verbatim in requirement: no agent was available for this
 * occurrence, so the task retries on the next tick exactly as it did before the claim
 * existed. The difference is that the occurrence ROW is now the thing being released, so the
 * release is recorded rather than inferred from a restored timestamp.
 */
export function releaseOccurrence(
  occurrenceId: string, workId: string, occurrenceMs: number | null,
  priorLastRunMs: number | null, reason: string,
): void {
  const db = getDb();
  withUnit(() => {
    // The release is recorded on the SCHEDULE, not on the occurrence: the occurrence row is
    // about to be deleted so its sequence can be claimed again, and an event on a row that
    // no longer exists is a record nobody can find.
    appendWorkEvent(workId, OCCURRENCE_EVENT.released, 'scheduler', { reason, occurrenceId });
    clearReferencesToWork([occurrenceId]);   // every reference, not just the events — see `work-refs.ts`
    db.prepare('DELETE FROM work WHERE id = ?').run(occurrenceId);
    // Same move as the claim's advance: the statement is `work/next-run.ts`'s, run inside
    // this unit so the delete and the restore stay one thing.
    restoreScheduleOnRelease(db, { workId, occurrenceMs, priorLastRunMs });
  });
  logger.info('occurrence released unfired', { workId, occurrenceId, reason });
}

/** The run word of a run that owed a person a message and reached nobody: not complete, with its reason
 *  on the row (the run history shows its neutral badge). */
export const RUN_STATUS_UNDELIVERED = 'undelivered';

/** A run that owes a message and delivered it, but was never handed in. */
export interface RunReadyToClose { occurrenceId: string; taskId: string; deliveryId: string }

/** Open runs whose task owes a person a message, whose own turn has ended, and whose window holds that
 *  message (`proofDelivery`, the engine's run rule): the scheduler closes them on it. */
export function runsReadyToCloseOnDelivery(): RunReadyToClose[] {
  const rows = getDb().prepare(`
    SELECT w.id AS occurrence_id, w.parent_id AS task_id FROM work w JOIN work p ON p.id = w.parent_id
     WHERE w.kind = ? AND w.state IN ('open','claimed') AND p.task_kind IS NOT NULL AND p.state <> 'handed_in'
       AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.root_kind = w.kind AND t.root_id = w.id AND t.ended_at IS NULL)
  `).all(OCCURRENCE_KIND) as Array<{ occurrence_id: string; task_id: string }>;
  return rows.flatMap((row) => {
    if (!occurrenceOwesDeliverable(row.occurrence_id).owes) return [];
    const deliveryId = proofDelivery(row.task_id, true);
    return deliveryId ? [{ occurrenceId: row.occurrence_id, taskId: row.task_id, deliveryId }] : [];
  });
}

export interface RunSettlement {
  /** The transition's own outcome. */
  outcome: WorkOutcome | null;
  /** The delivery the close points at, when one qualified. */
  deliveryId: string | null;
  /** Why, in one line, for the log and for the caller that wants to say something. */
  detail: string;
  /** T19 (D4): the run's own word AS RECORDED — the gate's word, not the caller's. The
   *  `occurrence_settled` event already carries it; a caller that has to surface the fact
   *  (the owner-facing ghost) reads it here instead of re-deriving the gate's decision. */
  runStatusRecorded: string;
}

/**
 * Settle an occurrence when its run closes.
 *
 * THE TERMINAL STATE IS THE RUN'S OWN OUTCOME, not a judgement this module makes:
 *
 *   run complete + a delivery resolves  ->  `done`, pointing at that delivery
 *   run complete + nothing delivered    ->  `abandoned`, saying so in its reason
 *   run failed                          ->  `failed`
 *   run skipped                         ->  `abandoned`
 *
 * The middle row is the one worth reading twice. G7 (`done` means DELIVERED) is a DB CHECK as
 * well as a gate, so a scheduled run that reached nobody CANNOT be recorded as done, and no
 * sentinel delivery is invented to pretend otherwise — the same call T7 made for commitments
 * and T8b made for tracker closes. `abandoned` with the reason on the row is the honest
 * record of "the schedule fired and nothing reached a person", and it keeps the phase's own
 * exit query (`state='open'` answers what is outstanding) free of spent occurrences.
 *
 * The run's WORD is gated as well as its row: a run whose task is DECLARED deliverable-owing
 * (`work/deliverable-declaration.ts`) that closes `complete` or `failed` with no delivery (the caller's
 * `deliveryId`, the run window's own delivery) is recorded `undelivered`, never complete, and the
 * schedule moves on; the worker gets one hint (`scheduler/runner.ts`). A task that owes nobody a
 * message is settled on the caller's word.
 */
export function settleOccurrence(
  occurrenceId: string, runStatus: string, deliveryId: string | null, summary: string | null,
): RunSettlement {
  // ── THE DELIVERABLE GATE. Only ever narrows a `complete` or a `failed`; `skipped` is
  //    untouched (a run that never ran owes nobody an explanation about a message it was
  //    never going to send — `skipOpenOccurrences` says so at its own call site). ──
  let effectiveStatus = runStatus;
  let effectiveDelivery = deliveryId;
  let gateNote: string | null = null;
  const left = runStatus === 'complete' ? runItemsLeft(occurrenceId) : null;   // v3.5: what the task's measure still lists
  if ((runStatus === 'complete' || runStatus === 'failed') && !deliveryId && occurrenceOwesDeliverable(occurrenceId).owes) {
    effectiveStatus = RUN_STATUS_UNDELIVERED;
    gateNote = 'the run ended without reaching the person it owed a message';
  } else if (runStatus === 'complete' && deliveryId && occurrenceOwesDeliverable(occurrenceId).owes) {
    gateNote = 'delivered in its own window';
  }
  // After the deliverable gate: only a run it would record complete is recorded incomplete for items left.
  if (left && effectiveStatus === 'complete') { effectiveStatus = RUN_STATUS_INCOMPLETE; effectiveDelivery = null; gateNote = `${countOf(left.left, left.unit)} left by the task's measure`; }

  // T2: the settle and the run's own word are ONE unit. The event is the ONLY carrier
  // of the discriminator between "finished, reached nobody" and "never ran" (both land on
  // `abandoned`), so losing it loses the fact the owner's run history renders.
  const outcome = withUnit((): WorkOutcome => {
  const runStatusInner = effectiveStatus;
  const deliveryIdInner = effectiveDelivery;
  let result: WorkOutcome;
  if (runStatusInner === 'failed') {
    result = transition(occurrenceId, {
      to: 'failed', by: 'scheduler', actorId: 'scheduler',
      reason: `the run for this occurrence failed${summary ? `: ${summary}` : ''}`,
      note: summary,
    });
  } else if (runStatusInner === 'complete' && deliveryIdInner) {
    result = transition(occurrenceId, {
      to: 'done', by: 'scheduler', actorId: 'scheduler',
      resultDeliveryId: deliveryIdInner,
      reason: `the run for this occurrence finished and delivered${gateNote ? ` (${gateNote})` : ''}`,
      note: summary,
    });
  } else {
    result = transition(occurrenceId, {
      to: 'abandoned', by: 'scheduler', actorId: 'scheduler',
      reason: runStatusInner === 'complete'
        ? 'the run for this occurrence finished with nothing delivered to a person'
        : runStatusInner === RUN_STATUS_INCOMPLETE
          ? `the run for this occurrence ended with ${gateNote}; it is recorded INCOMPLETE rather than complete`
        : runStatusInner === RUN_STATUS_UNDELIVERED
          ? 'the run for this occurrence ended and reached NOBODY: the task owes the person a '
            + 'user-visible message and none was ever sent. It is recorded UNDELIVERED rather '
            + `than ${runStatus === 'failed' ? 'failed' : 'complete'}`
          : `the occurrence was ${runStatusInner} without running`,
      note: summary,
    });
  }

  // PHASE-2 T10F — THE RUN'S OWN WORD, recorded because the STATE cannot carry it.
  //
  // `abandoned` is the terminal state for two different runs: one that finished and reached
  // nobody, and one that never ran at all. G7 makes that unavoidable (`done` is unreachable
  // without a delivery, and no sentinel is invented). But `task_runs.status` told those two
  // apart — the owner's run history renders `complete` for the first and `skipped` for the
  // second — so the discriminator is preserved HERE rather than lost in the mapping. It is an
  // event and not a column because it is a fact about the run, not about the row's state, and
  // `work_events` is where this spine puts facts about what happened.
  //
  // ⚠ SWEEP CORE-1 CT2 — AND THE WORD RECORDED IS THE GATE'S WORD, NOT THE CALLER'S. This line
  // used to write `runStatus` — whatever the caller said — which is how a run that reached
  // nobody came to render `complete` in the owner's history. It writes `runStatusInner`, the
  // word the deliverable gate above allowed. For every task that owes nobody anything the two
  // are the same value and this is a no-op.
  if (result.kind === 'applied') {
    const incomplete = runStatusInner === RUN_STATUS_INCOMPLETE ? left : null;   // the run history's "N <unit> left"
    appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.settled, 'scheduler', {
      run_status: runStatusInner, summary: summary ?? null, ...(incomplete ? { items_left: incomplete.left, unit: incomplete.unit } : {}),
    });
    if (incomplete) recordRunRemainder(occurrenceId, incomplete);
  }
  return result;
  });

  return {
    outcome,
    deliveryId: effectiveDelivery,
    detail: gateNote ?? `run settled ${effectiveStatus}`,
    runStatusRecorded: effectiveStatus,
  };
}

/** `settleOccurrence`'s outcome for the many callers that only want "did the row move". Kept as
 *  a named helper rather than repeated as `s.outcome?.kind === 'applied'` at five call sites. */
export function runSettleApplied(s: RunSettlement): boolean {
  return s.outcome?.kind === 'applied';
}

/**
 * Record who is actually running this occurrence.
 *
 * The claim has to happen BEFORE the assignee is known — it is what makes "fire once" a
 * constraint, and it fires on the schedule's own `assigned_to` (or `scheduler`). Who runs it is
 * resolved afterwards: a group pick, the primary-agent fallback, or the reassignment a
 * terminated assignee forces. `task_runs.assigned_to` was written at exactly this point
 * (`runner.ts` step 4) and the run history renders it, so the occurrence row learns it too
 * rather than keeping the schedule's stale guess.
 */
export function assignOccurrence(occurrenceId: string, agentId: string): void {
  getDb().prepare(
    `UPDATE work SET agent_id = ?, assignee_agent = ?, updated_at = ?
      WHERE id = ? AND kind = ?`,
  ).run(agentId, agentId, Date.now(), occurrenceId, OCCURRENCE_KIND);
}

/**
 * Close every open occurrence of a schedule as skipped, and return HOW MANY.
 *
 * The count is a preserved fact, not a log line: the fallen path quotes it to the owner
 * ("N open run(s) skipped") and gates the reminder heads-up on it being non-zero.
 */
export function skipOpenOccurrences(workId: string, reason: string): number {
  const open = getDb().prepare(
    `SELECT id FROM work WHERE kind = ? AND parent_id = ? AND state IN ('open','claimed')`,
  ).all(OCCURRENCE_KIND, workId) as Array<{ id: string }>;
  let closed = 0;
  for (const o of open) {
    // `skipped` is not `complete`, so the CT2 deliverable gate never sees this path: a run that
    // never ran owes nobody an explanation about a message it was never going to send.
    if (runSettleApplied(settleOccurrence(o.id, 'skipped', null, `Skipped: ${reason}; schedule stopped`))) {
      closed += 1;
    }
  }
  return closed;
}

/** RC-17.4's age guard, carried verbatim from the query it replaces
 *  (`scheduler/runner.ts` `cleanupStaleRuns`: `datetime('now','-5 minutes')`). It exists to
 *  avoid racing an in-flight advance, so it is not a threshold anybody invented here. */
export const ORPHAN_RUN_GRACE_MS = 5 * 60 * 1000;

/**
 * Sweep occurrences whose schedule is not running them.
 *
 * RC-17.4's invariant, unchanged: a legitimately in-flight run always has its parent at
 * `schedule_status='running'` — the claim sets both in one transaction, and close-out closes
 * the run BEFORE moving the schedule. So an open occurrence whose parent is not running it is
 * an orphan. Silent by design: this drains stale bookkeeping, it is not a live reminder the
 * owner needs told about.
 */
export function sweepOrphanedOccurrences(nowMs = Date.now()): number {
  const orphans = getDb().prepare(
    `SELECT w.id, w.parent_id, w.sequence FROM work w
       LEFT JOIN work p ON p.id = w.parent_id
      WHERE w.kind = ? AND w.state IN ('open','claimed')
        AND (p.id IS NULL OR p.schedule_status != 'running')
        AND w.opened_at < ?`,
  ).all(OCCURRENCE_KIND, nowMs - ORPHAN_RUN_GRACE_MS) as
    Array<{ id: string; parent_id: string; sequence: number }>;

  let swept = 0;
  for (const o of orphans) {
    const settled = settleOccurrence(
      o.id, 'skipped', null,
      'Auto-skipped: orphaned run (parent task not running this occurrence)',
    );
    if (runSettleApplied(settled)) {
      swept += 1;
      logger.warn('swept orphaned occurrence', {
        workId: o.parent_id, occurrenceId: o.id, sequence: o.sequence,
      });
    }
  }
  return swept;
}

/** Open occurrences whose assigned agent is terminated or gone. Reported, not closed: the
 *  caller routes them through the full run-complete flow, because closing the occurrence
 *  without advancing the schedule is what stalled a cadence before. */
export function sweepTerminatedAgentOccurrences(): Array<{
  occurrenceId: string; taskId: string; assignedTo: string | null;
}> {
  const rows = getDb().prepare(
    `SELECT w.id AS occurrence_id, w.parent_id AS task_id, w.agent_id AS assigned_to
       FROM work w LEFT JOIN agents a ON a.id = w.agent_id
      WHERE w.kind = ? AND w.state IN ('open','claimed')
        AND (a.id IS NULL OR a.status = 'terminated')`,
  ).all(OCCURRENCE_KIND) as Array<{
    occurrence_id: string; task_id: string; assigned_to: string | null;
  }>;
  return rows.map(r => ({
    occurrenceId: r.occurrence_id, taskId: r.task_id, assignedTo: r.assigned_to,
  }));
}

/**
 * Delete the occurrence rows of these schedules, and their events, returning the count.
 *
 * The three `DELETE FROM task_runs` sites were deleting runs alongside their tasks. On the
 * spine an occurrence is a CHILD `work` row, and `parent_id REFERENCES work(id)` has no
 * cascade — so this is no longer a courtesy: deleting a schedule without it fails on the
 * foreign key. Its own clause asserts that.
 */
export function deleteOccurrencesOf(workIds: string[]): number {
  if (workIds.length === 0) return 0;
  const db = getDb();
  const ph = workIds.map(() => '?').join(',');
  let removed = 0;
  withUnit(() => {
    const doomed = (db.prepare(`SELECT id FROM work WHERE kind = ? AND parent_id IN (${ph})`)
      .all(OCCURRENCE_KIND, ...workIds) as Array<{ id: string }>).map(r => r.id);
    clearReferencesToWork(doomed);           // every reference, not just the events — see `work-refs.ts`
    removed = db.prepare(
      `DELETE FROM work WHERE kind = ? AND parent_id IN (${ph})`,
    ).run(OCCURRENCE_KIND, ...workIds).changes;
  });
  return removed;
}

/** The occurrence this schedule has in flight, if any. A crashed fire leaves exactly this
 *  row behind, which is the property the old timestamp CAS could not provide. */
export function inFlightOccurrence(workId: string): { id: string; sequence: number } | null {
  const r = getDb().prepare(
    `SELECT id, sequence FROM work
      WHERE kind = ? AND parent_id = ? AND state = 'open'
      ORDER BY sequence DESC LIMIT 1`,
  ).get(OCCURRENCE_KIND, workId) as { id: string; sequence: number } | undefined;
  return r ?? null;
}
