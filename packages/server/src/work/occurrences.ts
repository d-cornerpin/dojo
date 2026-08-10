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
import { withUnit } from '../db/unit.js';
import { createLogger } from '../logger.js';
import type { WorkEventKind } from './event-kinds.js';
// SWEEP CORE-2 item 3 — the schedule's fire time has ONE writing module; these two statements
// are its, and are called from inside this file's transactions (see `work/next-run.ts`).
import { advanceScheduleOnClaim, restoreScheduleOnRelease } from './next-run.js';
import { transition, appendWorkEvent, type WorkOutcome } from './store.js';
import { NON_ANSWERING_DELIVERY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from './ask-settlement.js';
import { occurrenceOwesDeliverable } from './deliverable-declaration.js';
import {
  MAX_RUN_DELIVER_STEERS, RUN_STATUS_UNDELIVERED, RUN_DELIVER_STEER_MARKER,
  nextRunDeliverRung, recordRunDeliverStandDown, recordRunDeliverSteer, runDriveCount,
} from './run-deliver-drive.js';

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
    db.prepare('DELETE FROM work_events WHERE work_id = ?').run(occurrenceId);
    db.prepare('DELETE FROM work WHERE id = ?').run(occurrenceId);
    // Same move as the claim's advance: the statement is `work/next-run.ts`'s, run inside
    // this unit so the delete and the restore stay one thing.
    restoreScheduleOnRelease(db, { workId, occurrenceMs, priorLastRunMs });
  });
  logger.info('occurrence released unfired', { workId, occurrenceId, reason });
}

// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-1 CT2 — THE RUN'S OWN EVIDENCE PREDICATE.
//
// ── WHAT WAS THERE BEFORE, AND WHY IT COULD NOT REFUSE ANYTHING ──
// `settleOccurrence`'s caller passed whatever `work/tracker-store.ts:deliveryForAgentSince`
// returned: *the newest delivery by that agent since the run opened*, with one exclusion
// (`engine-ack`) and no others. That function is correct for the job it was written for — a
// TASK close, where an apprentice's a2a hand-off really is the delivery for that piece of work,
// and its own docstring says so. It is the wrong question for a scheduled BRIEF, and the
// measurement says how wrong: driven at `8a060c5` (behavioral run `bmslpj41gkx`), a real
// "Tomorrow Brief" run closed `done` — owner status **complete** — on delivery `b57483d6`,
// which is a `display_kind='tool-turn'` CHIP whose entire content is the `work_update(action=
// "status", status="complete")` call itself. THE RUN WAS MARKED COMPLETE ON THE CHIP OF THE
// CALL THAT MARKED IT COMPLETE. The real brief ("Tomorrow (Mon, Aug 10) is clear — no events on
// any of your calendars.") existed one delivery earlier and was not what the run closed on.
// Box-wide, 5,542 of 12,496 dashboard deliveries are chips, so this is not an edge.
//
// ── THE PREDICATE, and every narrowing is a negative control in the unit test ──
// Six, and five of them are the ask authority's own doctrine asked of a RUN's window instead of
// a TURN's. `NON_ANSWERING_DELIVERY_TOOLS` and `NON_ANSWERING_DISPLAY_KINDS` are IMPORTED from
// `work/ask-settlement.ts` rather than restated, for the reason that file gives for sharing
// `NOT_A_TOOL_CHIP` between its own two arms: so the lanes cannot drift apart.
//
// ── AND THE SIXTH IS THE ONE CT0 PAID FOR: READ THE REPLY, NOT ONLY THE ROW ──
// A `deliveries` row is a claim that something was sent. The message it points at is the
// evidence of WHAT. A receipt whose message row exists and is blank is a send of nothing, and
// the incident being closed here is precisely a run that looked settled from the row and was
// silence to the person. A delivery with NO message row at all is ADMITTED, not refused: every
// channel send records one that way (147 iMessage + 7 email on this box), and refusing those
// would red the one lane where the owner most reliably does get his brief.
// ════════════════════════════════════════════════════════════════════════════════

/** Deliveries that are not the agent supplying a result to a person. Two imported (the
 *  start-ack doctrine), two added by MEASUREMENT on this box with their populations stated:
 *  `alert` (1140/1140 carry no message row — the PLATFORM's own owner-alert voice, not the
 *  agent's work) and `a2a-join-failed` (3/3 — the engine saying no answer is coming, the exact
 *  opposite of a deliverable; `ask-settlement.ts` keeps it out of `ENGINE_JOIN_RELAY_TOOLS` for
 *  the same stated reason). `a2a-join-relay` is deliberately ADMITTED: when the engine hands a
 *  delegated job's COMPILED answer to the owner, the owner really did receive the result, and
 *  TB13's correction is kept whole here exactly as CT0 kept it whole in the ask lane. */
export const NON_DELIVERABLE_RUN_TOOLS = new Set([
  ...NON_ANSWERING_DELIVERY_TOOLS, 'alert', 'a2a-join-failed',
]);

/** Channels on which nothing reaches a PERSON. `a2a` is an apprentice hearing about it; `none`
 *  is the bookkeeping lane. Named rather than left to `outcome='delivered'` to filter, so the
 *  exclusion is a declaration and not an accident of another clause. */
export const NON_OWNER_CHANNELS = new Set(['a2a', 'none']);

/**
 * THE MESSAGE THIS RUN ACTUALLY SENT A PERSON, or null.
 *
 * Exported as a READ so a caller can ask the authority's own question without restating it —
 * `askAnswerEvidence`'s shape one lane over, and for the same reason: a second decider is the
 * disease this arc exists to cure. It decides nothing and writes nothing.
 *
 * The window is the RUN's own window (`opened_at` → now), floored to the second because
 * `deliveries.created_at` is `datetime('now')` and carries no milliseconds while
 * `work.opened_at` is epoch-ms; comparing at millisecond precision against a column that does
 * not have them manufactures false negatives inside the same second.
 */
export function runDeliverableEvidence(
  occurrenceId: string,
): { id: string; tool: string; channel: string } | null {
  const occ = getDb().prepare(
    `SELECT agent_id, opened_at FROM work WHERE id = ? AND kind = ?`,
  ).get(occurrenceId, OCCURRENCE_KIND) as { agent_id: string; opened_at: number } | undefined;
  if (!occ) return null;
  const tools = [...NON_DELIVERABLE_RUN_TOOLS];
  const channels = [...NON_OWNER_CHANNELS];
  const chipKinds = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool, d.channel AS channel FROM deliveries d
      WHERE d.agent_id = ? AND d.outcome = 'delivered'
        AND unixepoch(d.created_at) >= ?
        AND d.tool NOT IN (${tools.map(() => '?').join(', ')})
        AND d.channel NOT IN (${channels.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM messages m
                         WHERE m.id = d.message_id AND m.display_kind IN (${chipKinds}))
        AND NOT EXISTS (SELECT 1 FROM messages m
                         WHERE m.id = d.message_id AND TRIM(COALESCE(m.content, '')) = '')
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(occ.agent_id, Math.floor(occ.opened_at / 1000), ...tools, ...channels) as
    { id: string; tool: string; channel: string } | undefined) ?? null;
}

/** What a turn boundary did to the deliver ladder. `spent` is whether THIS turn's drive was
 *  newly recorded; `standDownDue` is whether the bound is now reached and the caller must run
 *  the honest close. */
export interface RunLadderTurnEnd {
  spent: boolean;
  standDownDue: boolean;
  taskId: string | null;
}

const NO_LADDER_MOVE: RunLadderTurnEnd = { spent: false, standDownDue: false, taskId: null };

/**
 * ⚠ UX-REPAIR ROUND 4 T19 (D3) — THE DRIVE TICK THE LADDER NEVER HAD.
 *
 * `runDriveCount` counts DISTINCT TURNS and that rule is MEASURED, not designed: behavioral
 * run `bmslqef2w3r` had the floor model call `work_update(status="complete")` FOUR TIMES
 * INSIDE ONE TURN before it had spoken at all, and counting ROWS spent the whole ladder in
 * ten seconds. The unit is the turn, and it stays the turn.
 *
 * But the count only ever MOVED when the model attempted another close — the steer is the
 * tool's own return value — so a model that stops calling the tool freezes the ladder wherever
 * it stands. The owner's box, 2026-08-10: three steers, all inside turn 4602, ledger reading
 * `1 of 3`, `2 of 3`, `2 of 3`. Rung 3 was never reached, `recordRunDeliverStandDown` never
 * ran, `RUN_STATUS_UNDELIVERED` was never written, and the run sat `open` for thirty minutes
 * until a generic idle reaper closed it with a sentence about the AGENT.
 *
 * A rung is a DRIVE — *"a separate attempt, with a turn in between for the agent to act on the
 * steer"* — and a turn that ENDED having been told, and delivered nothing, is exactly that
 * attempt, whether or not the model came back to the tool. So the turn boundary spends it.
 *
 * ── THE FOUR REFUSALS, each one a requirement this cannot break ──
 *   * the run must ALREADY carry a steer. An unsteered run never burns a rung here, so the
 *     ladder still cannot start itself and `closeRunsThatDelivered`'s steered arm's premise stands;
 *   * the anti-burn rule is untouched: this records ONE row keyed on THIS turn, and a turn
 *     already on the ledger records nothing (the count is DISTINCT turns, so a repeat is free
 *     by construction as well as by this guard);
 *   * evidence wins: a turn that delivered is not an attempt that failed;
 *   * it DECIDES and never CLOSES. The caller performs the stand-down through the ordinary
 *     run-complete flow, so the schedule advance, the notices and the audit trail are the
 *     same ones every other close produces (`join-drive.ts`'s rule, carried).
 */
export function advanceRunDeliverLadderAtTurnEnd(
  occurrenceId: string, turnNumber: number | null | undefined,
): RunLadderTurnEnd {
  if (turnNumber == null) return NO_LADDER_MOVE;
  const occ = getDb().prepare(
    `SELECT state FROM work WHERE id = ? AND kind = ?`,
  ).get(occurrenceId, OCCURRENCE_KIND) as { state: string } | undefined;
  if (!occ || (occ.state !== 'open' && occ.state !== 'claimed')) return NO_LADDER_MOVE;

  const owed = occurrenceOwesDeliverable(occurrenceId);
  if (!owed.owes) return NO_LADDER_MOVE;
  // Never STARTS the ladder — only advances one that the model's own close attempt began.
  if (runDriveCount(occurrenceId, RUN_DELIVER_STEER_MARKER) === 0) return NO_LADDER_MOVE;
  if (runDeliverableEvidence(occurrenceId)) return NO_LADDER_MOVE;

  const alreadyThisTurn = (getDb().prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit'
        AND json_extract(payload, '$.marker') = ?
        AND json_extract(payload, '$.turn_number') = ?`,
  ).get(occurrenceId, RUN_DELIVER_STEER_MARKER, turnNumber) as { n: number }).n > 0;

  let spent = false;
  if (!alreadyThisTurn) {
    const rung = nextRunDeliverRung(occurrenceId);
    recordRunDeliverSteer(occurrenceId, {
      attempt: rung.attempt, bound: rung.bound, taskId: owed.taskId ?? occurrenceId,
      why: 'the turn ended with nothing user-visible sent, on a run that had already been steered',
      turnNumber,
    });
    spent = true;
  }
  return {
    spent,
    standDownDue: nextRunDeliverRung(occurrenceId).rung === 'stand-down',
    taskId: owed.taskId ?? null,
  };
}

/** A run the delivery ledger says is finished, and whether anybody steered it. */
export interface RunReadyToClose {
  occurrenceId: string;
  taskId: string;
  deliveryId: string;
  tool: string;
  steered: boolean;
}

/**
 * ⚠ UX-REPAIR ROUND 4 T19 (D6) — THE COMPLEMENT OF THE VERIFY RUNG.
 *
 * The verify rung (`scheduler/runner.ts`) required a steer marker and its header states the clause as
 * load-bearing: *"the steer is the agent's own assertion that the work is finished, refused
 * only for want of evidence; without it this sweep would be closing runs nobody said were
 * done."* That worry is real and it is ANSWERED HERE rather than deleted: the complement case
 * — the model DELIVERS FIRST and never attempts a close at all — produces no marker, and the
 * deliverable authority's own predicate is STRONGER evidence than an assertion. A steer is the
 * agent SAYING it is finished; `runDeliverableEvidence` is the ledger showing the person got
 * something.
 *
 * Measured, driven, 2026-08-10 18:45Z: a one-shot reminder was delivered to the owner
 * (`agent-text`, a real `deliveries` row) and the run sat `open` for twelve minutes, was
 * refused `complete` twice for want of a pointer it already had, and was only resolved because
 * a PM poke dragged the model back. Absent that it meets the 30-minute idle reaper and a
 * perfectly delivered reminder is recorded failed.
 *
 * ⚠ AND THE ROW SET IS WHERE THE NARROWING LIVES, not in a second predicate. The sweep chooses
 * WHICH runs to ask about; `runDeliverableEvidence` is still the only thing that answers. The
 * one added clause is the turn boundary — an agent with a turn still in flight is mid-work,
 * and closing its run out from under it is the race the orphan sweep's own age guard exists to
 * avoid. CT0's doctrine, carried: the turn boundary is where a fact about a turn becomes
 * readable. A STEERED run keeps today's behaviour exactly — the model asked to close, so
 * there is nothing to race.
 */
export function runsReadyToCloseOnDelivery(): RunReadyToClose[] {
  const rows = getDb().prepare(`
    SELECT w.id AS occurrence_id, w.parent_id AS task_id,
           EXISTS (SELECT 1 FROM work_events e
                    WHERE e.work_id = w.id AND e.kind = 'audit'
                      AND json_extract(e.payload, '$.marker') = ?) AS steered
      FROM work w
      JOIN work p ON p.id = w.parent_id
     WHERE w.kind = ? AND w.state IN ('open','claimed')
       AND p.task_kind IS NOT NULL
  `).all(RUN_DELIVER_STEER_MARKER, OCCURRENCE_KIND) as
    Array<{ occurrence_id: string; task_id: string; steered: number }>;

  const out: RunReadyToClose[] = [];
  for (const row of rows) {
    if (!occurrenceOwesDeliverable(row.occurrence_id).owes) continue;
    if (!row.steered && runHasTurnInFlight(row.occurrence_id)) continue;
    const evidence = runDeliverableEvidence(row.occurrence_id);
    if (!evidence) continue;
    out.push({
      occurrenceId: row.occurrence_id, taskId: row.task_id,
      deliveryId: evidence.id, tool: evidence.tool, steered: row.steered === 1,
    });
  }
  return out;
}

/**
 * Is THIS RUN's own turn still going? A `turns` row with no `ended_at` has not finished (the
 * column carries a CHECK pairing it with `exit_reason`, so there is no third state to read),
 * and `root_kind`/`root_id` are what the turn stamps to say which occurrence it is serving.
 *
 * ⚠ IT ASKS ABOUT THE RUN, NOT THE AGENT, AND THAT IS A DRIVEN CATCH. The first draft asked
 * "does this agent have any unended turn", which on a lived-in box is permanently TRUE: the
 * dev body carries 22 unended `turns` rows for one agent and 279 across seven, every one of
 * them a turn some crash or restart never closed. A guard keyed on that would have made the
 * whole unsteered arm dead on arrival — silently, which is the exact failure class this phase
 * exists to kill. Caught by the driven run (2026-08-10 19:43Z, occurrence `84b79c31`: the
 * reminder was delivered, the evidence was on the ledger, and the sweep skipped it).
 *
 * Scoped to the run, the predicate says what it means: do not close a run out from under the
 * turn that is serving it. An unended row on THIS occurrence still blocks — correctly, and
 * boundedly, because a run nobody is serving meets the idle reaper.
 */
function runHasTurnInFlight(occurrenceId: string): boolean {
  const hit = getDb().prepare(
    `SELECT 1 AS ok FROM turns
      WHERE root_kind = ? AND root_id = ? AND ended_at IS NULL LIMIT 1`,
  ).get(OCCURRENCE_KIND, occurrenceId) as { ok: number } | undefined;
  return hit !== undefined;
}

/** What `settleOccurrence` answers. `owed` is the arm CT2 adds: the run is NOT settled, nothing
 *  was transitioned, and the caller must steer rather than advance. */
export type RunSettlementVerdict = 'settled' | 'owed';

export interface RunSettlement {
  verdict: RunSettlementVerdict;
  /** The transition's own outcome — null on the `owed` arm, because nothing moved. */
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
 * ⚠ SWEEP CORE-1 CT2 — AND YET THE OWNER STILL READ "COMPLETE", which is the whole incident.
 * G7 protected the ROW and nothing protected the WORD. The `occurrence_settled` event below
 * carried `run_status: 'complete'` UNCONDITIONALLY whenever the caller said so, and
 * `work/occurrence-runs.ts:runStatusOf` renders `abandoned` + that word as **complete** in the
 * owner's run history. `abandoned` is a state only a developer reads; `complete` is what he
 * saw on the morning nothing arrived. So the gate below is on the WORD as much as on the row:
 *
 *   the task is DECLARED deliverable-owing (`work/deliverable-declaration.ts`) — the only
 *   question asked, one column, never the run's prose — and the caller says `complete`:
 *     * a qualifying delivery exists   -> `done` on THAT delivery, whatever the caller passed;
 *     * none, ladder not spent          -> `owed`. NOTHING is transitioned and NOTHING is
 *                                          recorded complete. The caller steers the agent.
 *     * none, ladder spent              -> settled `abandoned` with the run's own word set to
 *                                          `undelivered`. The owner's history shows a run that
 *                                          is not complete, carrying the reason. Never a lie.
 *
 * A task that is NOT declared deliverable-owing is settled exactly as before, byte for byte:
 * a nightly backup owes nobody a message and this gate must not invent one for it.
 *
 * ⚠ THE CALLER NARROWS THE SCOPE; THE AUTHORITY DECIDES. For a declared run the `deliveryId`
 * argument is re-derived here rather than trusted, because the only thing that produces it
 * (`deliveryForAgentSince`) answers a deliberately wider question — CT0's rule for the join
 * arm's `deliveryId`, applied to the lane it belongs in.
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
  if (runStatus === 'complete') {
    const owed = occurrenceOwesDeliverable(occurrenceId);
    if (owed.owes) {
      const evidence = runDeliverableEvidence(occurrenceId);
      if (evidence) {
        effectiveDelivery = evidence.id;
        gateNote = `delivered via ${evidence.tool} on ${evidence.channel}`;
      } else {
        const rung = nextRunDeliverRung(occurrenceId);
        if (rung.rung === 'steer') {
          return {
            verdict: 'owed',
            outcome: null,
            deliveryId: null,
            detail: `the run cannot be recorded complete: "${owed.taskKind}" work owes the person a `
              + 'user-visible message and nothing was sent in this run\'s window '
              + `(steer ${rung.attempt} of ${rung.bound})`,
            runStatusRecorded: runStatus,
          };
        }
        // The ladder is spent. The run is recorded UNDELIVERED — never complete.
        recordRunDeliverStandDown(occurrenceId, {
          steersSpent: rung.steersSpent, taskId: owed.taskId ?? occurrenceId,
        });
        effectiveStatus = RUN_STATUS_UNDELIVERED;
        effectiveDelivery = null;
        gateNote = `stood down after ${rung.steersSpent} steer(s) with nothing delivered`;
      }
    }
  } else if (runStatus === 'failed') {
    // ⚠ UX-REPAIR ROUND 4 T19 (D4) — THE `failed` CLOSE WALKED PAST THIS GATE, AND THAT IS
    // HOW THE INCIDENT ENDED. `cleanupStaleRuns` is a stalled-agent safety net and it stays
    // one: its 30-minute idle rule, its retry-next-cycle promise and its trigger are all
    // untouched. What it may no longer do is choose the WORD. On 2026-08-10 it closed a
    // reminder run `failed` with the note *"Auto-failed: assigned agent idle for 30+ minutes"*
    // — true about the agent, silent about the owner, and rendered as a neutral badge behind
    // two clicks in an expanded task detail. The owner's run history said the agent was idle
    // for a morning his reminder never reached him.
    //
    // A run that was DECLARED deliverable-owing and reached nobody has exactly one honest
    // word, and the platform already owns it: UNDELIVERED, with the stand-down on the row.
    // The `failed` arm is NEVER refused (`owed` would leave a stalled run open for ever,
    // which is the safety net's own failure mode) — it is RENAMED by the authority, which is
    // what the gate above already does for `complete`. A run that DID deliver keeps the
    // caller's `failed`: the run genuinely failed, and the word is about the run.
    const owed = occurrenceOwesDeliverable(occurrenceId);
    if (owed.owes && !runDeliverableEvidence(occurrenceId)) {
      recordRunDeliverStandDown(occurrenceId, {
        steersSpent: runDriveCount(occurrenceId, RUN_DELIVER_STEER_MARKER),
        taskId: owed.taskId ?? occurrenceId,
      });
      effectiveStatus = RUN_STATUS_UNDELIVERED;
      effectiveDelivery = null;
      gateNote = 'the run ended without reaching the person it owed a message';
    }
  }

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
    appendWorkEvent(occurrenceId, OCCURRENCE_EVENT.settled, 'scheduler', {
      run_status: runStatusInner, summary: summary ?? null,
    });
  }
  return result;
  });

  return {
    verdict: 'settled',
    outcome,
    deliveryId: effectiveDelivery,
    detail: gateNote ?? `run settled ${effectiveStatus}`,
    runStatusRecorded: effectiveStatus,
  };
}

/** `settleOccurrence`'s outcome for the many callers that only want "did the row move". Kept as
 *  a named helper rather than repeated as `s.outcome?.kind === 'applied'` at five call sites. */
export function runSettleApplied(s: RunSettlement): boolean {
  return s.verdict === 'settled' && s.outcome?.kind === 'applied';
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

/**
 * Close every open occurrence of a schedule recording the run's own word as `complete`.
 *
 * The three sites this replaces all said the same thing —
 * `UPDATE task_runs SET status='complete' ... WHERE status='running'` — when a human-or-agent
 * decision retired the whole schedule: "all runs completed by agent", "schedule stopped and
 * marked complete", "auto-completed: group deleted". None of them had a delivery to point at,
 * so the occurrence settles `abandoned` (G7: `done` means DELIVERED, and no sentinel is
 * invented) while the run history still reads `complete`, which is what the caller asserted.
 *
 * ⚠ SWEEP CORE-1 CT2 — AND "WHAT THE CALLER ASSERTED" IS EXACTLY WHAT THIS SWEEP REMOVED AS AN
 * AUTHORITY. The paragraph above is the incident stated as a design: an agent's assertion,
 * carried into the owner's run history as the word `complete`, with `deliveryId` hard-coded
 * `null` at the call below — i.e. a run recorded complete that could not possibly have been
 * closed on evidence, at three real call sites. For a task that owes nobody a message that
 * remains correct and is untouched. For a DECLARED deliverable-owing task the gate inside
 * `settleOccurrence` now re-derives the run's own evidence and, finding none, either refuses
 * (returning `owed`, which this counter does not count) or records the run UNDELIVERED. The
 * caller's word narrows the scope; it no longer decides the fact.
 *
 * The count it returns is unchanged in meaning: how many runs this call actually closed. A run
 * left `owed` is deliberately NOT counted, so the sentence the caller prints to the owner
 * ("N open run(s) skipped") stays true.
 */
export function skipOpenOccurrencesAsComplete(workId: string, summary: string): number {
  const open = getDb().prepare(
    `SELECT id FROM work WHERE kind = ? AND parent_id = ? AND state IN ('open','claimed')`,
  ).all(OCCURRENCE_KIND, workId) as Array<{ id: string }>;
  let closed = 0;
  for (const o of open) {
    if (runSettleApplied(settleOccurrence(o.id, 'complete', null, summary))) closed += 1;
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
    db.prepare(
      `DELETE FROM work_events WHERE work_id IN (
         SELECT id FROM work WHERE kind = ? AND parent_id IN (${ph}))`,
    ).run(OCCURRENCE_KIND, ...workIds);
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
