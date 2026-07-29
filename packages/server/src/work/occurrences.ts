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

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { transition, appendWorkEvent, type TransitionResult } from './store.js';

const logger = createLogger('occurrences');

/** `kind` of the rows this module owns. `store.ts:evidenceResolves` already admits a `work`
 *  row of this kind as evidence for an engine transition (G6) — the half of T2's design that
 *  has been waiting for a writer. */
export const OCCURRENCE_KIND = 'occurrence';

/** The event kinds an occurrence carries. `work_events.kind` has no CHECK, so the guard
 *  against a writer/reader typo is that both sides import these. */
export const OCCURRENCE_EVENT = {
  /** The claim was won and the run is being started. Payload: `{ sequence, scheduled_for }`. */
  fired: 'occurrence_fired',
  /** A won claim was handed back unfired (no agent available). Payload: `{ reason }`. */
  released: 'occurrence_released',
} as const;

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
    db.transaction(() => {
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

      const advanced = db.prepare(`
        UPDATE work
           SET schedule_status = 'running', last_run_at = ?, next_run_at = ?, updated_at = ?
         WHERE id = ? AND schedule_status = 'waiting' AND is_paused = 0
           AND next_run_at = ? AND next_run_at <= ?
      `).run(input.nowMs, input.nextRunMs, input.nowMs, input.workId,
             input.occurrenceMs, input.nowMs);

      // The schedule moved out from under this tick (paused, re-timed, or already claimed by
      // a process that got here first). Roll the occurrence row back with it — a claim token
      // whose schedule disagrees is not a claim.
      if (advanced.changes !== 1) throw new LostClaim();

      appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.fired, 'scheduler', {
        sequence: input.sequence, scheduled_for: input.occurrenceMs,
      });
      won = true;
    })();
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
  db.transaction(() => {
    // The release is recorded on the SCHEDULE, not on the occurrence: the occurrence row is
    // about to be deleted so its sequence can be claimed again, and an event on a row that
    // no longer exists is a record nobody can find.
    appendWorkEvent(workId, OCCURRENCE_EVENT.released, 'scheduler', { reason, occurrenceId });
    db.prepare('DELETE FROM work_events WHERE work_id = ?').run(occurrenceId);
    db.prepare('DELETE FROM work WHERE id = ?').run(occurrenceId);
    db.prepare(`
      UPDATE work SET schedule_status = 'waiting', next_run_at = ?, last_run_at = ?, updated_at = ?
       WHERE id = ?
    `).run(occurrenceMs, priorLastRunMs, Date.now(), workId);
  })();
  logger.info('occurrence released unfired', { workId, occurrenceId, reason });
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
 */
export function settleOccurrence(
  occurrenceId: string, runStatus: string, deliveryId: string | null, summary: string | null,
): TransitionResult {
  if (runStatus === 'failed') {
    return transition(occurrenceId, {
      to: 'failed', by: 'scheduler', actorId: 'scheduler',
      reason: `the run for this occurrence failed${summary ? `: ${summary}` : ''}`,
    });
  }
  if (runStatus === 'complete' && deliveryId) {
    return transition(occurrenceId, {
      to: 'done', by: 'scheduler', actorId: 'scheduler',
      resultDeliveryId: deliveryId,
      reason: 'the run for this occurrence finished and delivered',
    });
  }
  return transition(occurrenceId, {
    to: 'abandoned', by: 'scheduler', actorId: 'scheduler',
    reason: runStatus === 'complete'
      ? 'the run for this occurrence finished with nothing delivered to a person'
      : `the occurrence was ${runStatus} without running`,
  });
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
