// ════════════════════════════════════════════════════════════════════════════════
// THE ANSWERED EDGE — the ONE place this tree answers "has the person heard from us".
// PHASE-2 T6 (research 07-FULL requirement rows 1a, 1b, 1c, 1e, 1g, 2b, 2d).
//
// WHAT THIS REPLACES, named so the removal can be checked rather than trusted. Seven
// mechanisms each carried their own definition, and research 07 §1 records what each one
// got wrong when they disagreed:
//
//   * a PROSE CLASSIFIER (`CLOSEOUT_WHOLE_RE`, a 20-phrase regex) decided whether the
//     model's last line "was a closeout" and suppressed it — prose as authority, the exact
//     shape the deliverable-claim floor was removed for TWICE (research 21, caution 2);
//   * `state.surfacedReplyThisTurn` / `deferredDeliveredByAck`, turn-local booleans that a
//     process death erases;
//   * a scan of `legacy_tasks.status='complete'` joined by hand, per row, to
//     `messages.answer_message_id`;
//   * `hasUnansweredUser`, an ARRAY the loop had to build (with a per-row origin
//     re-derivation) just to ask "is anything outstanding";
//   * `conv_key IS NULL` and `swept_at IS NULL`, two columns on the message doing the
//     obligation's job (PHASE-2 T3 took the first half, this file finishes the reading
//     side);
//   * `terminalAnswerRowId`, a loop-local variable set at four persist sites;
//   * and the turn record's OWN `exit_reason` / `answered` / `answer_message_id`, which
//     `finalizeTurn` has always written and which NOTHING read (research 21, R-0 — "the
//     one-line proof of the whole thesis").
//
// The edge itself is `work.result_delivery_id`: work is answered because something was
// DELIVERED, and the delivery is a row written by the transport door that performed the
// send (PHASE-2 T5). `messages.answer_message_id` (migration 113) stays as the second half
// of the same edge — requirement 2d says one edge must serve BOTH the answer-receipt read
// and the closeout-owe read — and it is the dated fallback for rows written before the
// ticket existed, exactly the way T5 dated its own pre-ledger fallbacks.
//
// EVERY FUNCTION HERE IS A READER, with two exceptions at the bottom (the pause and its
// reopen), and those two are marked, argued and named to their converting task.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { TurnExitReason } from './turn-record.js';
import { writeTaskLog } from '../../tracker/task-log.js';
import { askIdForMessage, type WorkState } from '../../work/store.js';
import { taskScope, tsToMs, type TrackerStatus } from '../../work/tracker-view.js';
import { setTrackerStatus } from '../../work/tracker-store.js';

const logger = createLogger('answered-edge');

/** Deliveries that are not an ANSWER to anybody. `engine-ack` is the engine saying "on it"
 *  at the START of the work (OR2-PROVISIONAL; PHASE-4 T4 removes the lane), and counting it
 *  would mark a question answered before anybody looked at it. Kept in step with
 *  `work/store.ts`'s `NON_ANSWERING_DELIVERY_TOOLS` by the conformance test beside it. */
const NON_ANSWERING_TOOLS = ["'engine-ack'"];

// ════════════════════════════════════════════════════════════════════════════════
// 2d — the answer-receipt read AND the closeout-owe read, from one place.
// ════════════════════════════════════════════════════════════════════════════════

export interface AnswerReceipt {
  /** Has the person had an answer to this ask? */
  answered: boolean;
  /** The delivery that proves it, when the spine holds one. */
  deliveryId: string | null;
  /** The answering message row (migration 113), when one was stamped. */
  answerMessageId: string | null;
  /** True when this ask has no ticket at all — a row written before PHASE-2 T3. */
  legacyRow: boolean;
}

const NO_RECEIPT: AnswerReceipt = {
  answered: false, deliveryId: null, answerMessageId: null, legacyRow: false,
};

/**
 * Requirement 2d, both directions at once.
 *
 * `answered === true`  -> the ANSWER-RECEIPT read: the person has it, do not re-announce.
 * `answered === false` -> the CLOSEOUT-OWE read: this ask still owes an answer.
 *
 * The two records are unioned deliberately rather than ranked. The ticket's
 * `result_delivery_id` is the strong form and is what every new row gets; the mig-113 stamp
 * covers rows written before the ticket existed AND any send path whose delivery record is
 * still missing. Erring toward "answered" here can only ever SUPPRESS a second
 * announcement; erring the other way re-tells a person something they already have, which
 * is the defect this machinery exists to prevent (owner transcript 2026-07-23).
 */
export function answerReceiptForAsk(messageId: string | null | undefined): AnswerReceipt {
  if (!messageId) return NO_RECEIPT;
  const db = getDb();
  const row = db.prepare(
    `SELECT w.state AS state, w.result_delivery_id AS delivery_id, m.answer_message_id AS answer_message_id,
            (w.id IS NULL) AS no_ticket, (m.id IS NULL) AS no_message
       FROM (SELECT ? AS mid) q
       LEFT JOIN work w ON w.id = ?
       LEFT JOIN messages m ON m.id = q.mid`,
  ).get(messageId, askIdForMessage(messageId)) as
    | { state: string | null; delivery_id: string | null; answer_message_id: string | null;
        no_ticket: number; no_message: number }
    | undefined;
  if (!row || (row.no_ticket === 1 && row.no_message === 1)) return NO_RECEIPT;
  // ── PHASE-2 T8c item 2 — THE STAMP ARM WAS BOOKED TO GO PURE-LEGACY HERE, AND THE
  // MEASUREMENT REFUSED IT. T6 concern 5 predicted that once tasks lived on the spine the
  // mig-113 stamp would be a pure legacy fallback and could be dated out. Re-derived at this
  // HEAD, READONLY, on this box:
  //
  //   stamped messages with NO ask ticket at all (genuinely legacy, pre-T3)   -> 586
  //   stamped messages WITH a ticket that is not done-with-delivery           ->  19
  //   ...and every one of those 19 is state='abandoned', not 'open'
  //
  // So the 19 are not legacy rows and not a bug in the ticket: they are asks a person WAS
  // answered on and that T6's unservable-ask reaper later abandoned. Ranking the ticket above
  // the stamp would flip all nineteen from "answered" to "not answered", and the consequence
  // of THAT error is re-telling somebody something they already have — the direction T6
  // deliberately chose against. The union therefore stands, and it stands on a measurement
  // rather than on inertia.
  //
  // RETIREMENT CONDITION, as a command rather than a feeling (T10 owns it): the stamp arm may
  // be dropped when this returns 0 —
  //   SELECT count(*) FROM messages m JOIN work w ON w.root_id = m.id AND w.kind='ask'
  //    WHERE m.answer_message_id IS NOT NULL
  //      AND NOT (w.state='done' AND w.result_delivery_id IS NOT NULL);
  // What IS ranked, and always was: `deliveryId` comes from the ticket or not at all, so a
  // caller that needs a receipt it can point at never gets one the stamp cannot back.
  const byTicket = row.state === 'done' && row.delivery_id !== null;
  const byStamp = row.answer_message_id !== null;
  return {
    answered: byTicket || byStamp,
    deliveryId: byTicket ? row.delivery_id : null,
    answerMessageId: row.answer_message_id,
    legacyRow: row.no_ticket === 1,
  };
}

/** The closeout-owe read, phrased the way its callers ask it. */
export function owesAnswer(messageId: string | null | undefined): boolean {
  return !answerReceiptForAsk(messageId).answered;
}

/**
 * The agent's OWN recorded answer in this conversation, most recent first.
 *
 * The engine hands this back to the model to restate when a question it already answered is
 * ghosted a second time (OR2: the engine never speaks as the agent, so it quotes the
 * agent's own words rather than re-serving them itself). It is the answered edge walked in
 * the other direction — from the ask to the reply — and it lives here so the edge has one
 * home rather than a hand-written two-table join inside the loop.
 */
export function recordedAnswerInConversation(agentId: string, conversationId: string): string | null {
  const r = getDb().prepare(
    `SELECT m2.content AS answer
       FROM messages m1 JOIN messages m2 ON m2.id = m1.answer_message_id
      WHERE m1.agent_id = ? AND m1.role = 'user' AND m1.conversation_id = ?
        AND m1.answer_message_id IS NOT NULL AND m2.role = 'assistant'
      ORDER BY m1.created_at DESC LIMIT 1`,
  ).get(agentId, conversationId) as { answer: string } | undefined;
  return r?.answer ?? null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1a — "did THIS turn already put the result in front of the person": a RECEIPT.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Requirement 1a. The old question was "does this text look like a closeout"; the honest
 * question is "is there a delivery on the ledger for this turn". PHASE-2 T5 made deliveries
 * universal at the five transport doors, so this is now answerable for every channel
 * including the dashboard bubble, which recorded nothing at all before that task.
 *
 * `conversationId` narrows to the person this turn is addressing: an email sent to a third
 * party while working on the owner's question is not the owner's answer. Pass `null` only
 * when the caller genuinely means "any person".
 */
export function turnDeliveredToPerson(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): boolean {
  if (turnNumber == null) return false;
  const db = getDb();
  const scoped = conversationId != null;
  const hit = db.prepare(
    `SELECT 1 AS ok FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered'
        AND channel <> 'a2a'
        AND tool NOT IN (${NON_ANSWERING_TOOLS.join(', ')})
        ${scoped ? 'AND conversation_id = ?' : 'AND conversation_id IS NOT NULL'}
      LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { ok: number } | undefined;
  return hit !== undefined;
}

/**
 * Requirement 1g — the DELIVERY the truthful-answer key points at.
 *
 * `terminalAnswerRowId` is `result_delivery_id` in embryo (research 07 §1): a loop-local
 * pointer to the message row that WAS the answer, set at four genuine user-facing persists
 * and nowhere else. What it never had was the receipt — the row proving the message left
 * the building. This resolves it from the same ledger every other reader here uses, so the
 * outcome ladder, the ticket stamps and the owe-filter are all looking at one fact.
 *
 * Newest first: a turn that delivered twice (a reply plus a stranded-file surface) is
 * proven by its latest send, which is the one the answer row belongs to.
 */
export function terminalDeliveryForTurn(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): string | null {
  if (turnNumber == null) return null;
  const scoped = conversationId != null;
  const r = getDb().prepare(
    `SELECT id FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered'
        AND channel <> 'a2a'
        AND tool NOT IN (${NON_ANSWERING_TOOLS.join(', ')})
        ${scoped ? 'AND conversation_id = ?' : 'AND conversation_id IS NOT NULL'}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { id: string } | undefined;
  return r?.id ?? null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1b — "did work close WITHOUT a delivery": a JOIN.
// ════════════════════════════════════════════════════════════════════════════════

export interface ClosedWithoutDelivery {
  workId: string;
  kind: string;
  title: string | null;
  rootId: string;
  state: string;
  conversationId: string | null;
}

/**
 * Requirement 1b. Work that reached a terminal state inside the window with nothing
 * delivered for it. `done` cannot appear here — the DDL's own CHECK forbids `done` without
 * `result_delivery_id`, which is the point: the only way to close silently is to close
 * `failed` or `abandoned`, and that is a fact the engine should say out loud rather than a
 * pattern it should detect in prose.
 */
export function closedWithoutDelivery(
  agentId: string, sinceMs: number, limit = 5,
): ClosedWithoutDelivery[] {
  return getDb().prepare(
    `SELECT id AS workId, kind, title, root_id AS rootId, state, conversation_id AS conversationId
       FROM work
      WHERE agent_id = ? AND state IN ('done','failed','abandoned')
        AND closed_at >= ? AND result_delivery_id IS NULL
      ORDER BY closed_at ASC LIMIT ?`,
  ).all(agentId, sinceMs, limit) as ClosedWithoutDelivery[];
}

// ════════════════════════════════════════════════════════════════════════════════
// 1c — turn end enumerates still-claimed work, WITH the identity to escalate.
// ════════════════════════════════════════════════════════════════════════════════

export interface ClaimedWork {
  workId: string;
  kind: string;
  title: string | null;
  conversationId: string | null;
  claimedByTurn: number | null;
  rootId: string;
}

/**
 * Requirement 1c. The escalation used to enumerate `legacy_tasks.status='in_progress'` and
 * then hunt for who to tell; a claim is a state on the spine now and it carries the
 * conversation it belongs to, so the identity comes back with the row.
 */
export function stillClaimedWork(
  agentId: string, opts?: { turnNumber?: number | null; limit?: number },
): ClaimedWork[] {
  const db = getDb();
  const turnNumber = opts?.turnNumber ?? null;
  const limit = opts?.limit ?? 10;
  const params: unknown[] = [agentId];
  let clause = '';
  if (turnNumber != null) { clause = 'AND claimed_by_turn = ?'; params.push(turnNumber); }
  params.push(limit);
  return db.prepare(
    `SELECT id AS workId, kind, title, conversation_id AS conversationId,
            claimed_by_turn AS claimedByTurn, root_id AS rootId
       FROM work
      WHERE agent_id = ? AND state = 'claimed' ${clause}
      ORDER BY opened_at ASC LIMIT ?`,
  ).all(...params) as ClaimedWork[];
}

// ════════════════════════════════════════════════════════════════════════════════
// 1e — "settled" is ONE query.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Requirement 1e: "any work open for a human counterparty right now?"
 *
 * The consumers are the proactive-send budget and the settled-context channel hold. Both
 * used `!hasUnansweredUser`, which required BUILDING the waiting set — fifty rows, a
 * per-row origin re-derivation and a Map — to learn a single boolean.
 *
 * SCOPE, stated because it is a decision and not an accident: `kind='ask'`. An open TASK is
 * work the agent owes ITSELF; an open ASK is a person waiting on a reply, which is what
 * "settled" has always meant here and what the proactive budget is calibrated against.
 * Widening it to every open row would silence the settled-context hint on any box carrying
 * an open backlog, which is a behaviour change nobody asked for.
 *
 * The join to `messages` is the identity half and it is load-bearing: an ask whose root row
 * is gone (a cleared history, a terminated agent) can never be served, and counting it would
 * leave the agent permanently un-settled. It is the same join the waiting set makes, so the
 * two cannot drift apart.
 */
export function hasOpenHumanWork(agentId: string): boolean {
  const hit = getDb().prepare(
    `SELECT 1 AS ok
       FROM work w JOIN messages m ON m.id = w.root_id AND m.agent_id = w.agent_id
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'open' AND w.requester = 'owner'
      LIMIT 1`,
  ).get(agentId) as { ok: number } | undefined;
  return hit !== undefined;
}

// ════════════════════════════════════════════════════════════════════════════════
// The turn-outcome reader (PHASE-2 T2 adjudication #3 — the orphan-gate debt on
// `turns.exit_reason`). R-0's finding was that `finalizeTurn` writes the true outcome and
// nothing reads it. This is the reader, and the disposition below is its consumer.
// ════════════════════════════════════════════════════════════════════════════════

export interface TurnOutcome {
  exitReason: TurnExitReason | null;
  answered: boolean;
  answerMessageId: string | null;
  effectfulCalls: number;
  ended: boolean;
  convKey: string | null;
  subjectId: string | null;
}

export function turnOutcome(agentId: string, turnNumber: number | null | undefined): TurnOutcome | null {
  if (turnNumber == null) return null;
  const r = getDb().prepare(
    `SELECT exit_reason, answered, answer_message_id, effectful_calls, ended_at, conv_key, subject_id
       FROM turns WHERE agent_id = ? AND turn_number = ?`,
  ).get(agentId, turnNumber) as
    | { exit_reason: string | null; answered: number; answer_message_id: string | null;
        effectful_calls: number; ended_at: string | null; conv_key: string | null; subject_id: string | null }
    | undefined;
  if (!r) return null;
  return {
    exitReason: (r.exit_reason as TurnExitReason | null) ?? null,
    answered: r.answered === 1,
    answerMessageId: r.answer_message_id,
    effectfulCalls: r.effectful_calls ?? 0,
    ended: r.ended_at !== null,
    convKey: r.conv_key,
    subjectId: r.subject_id,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// THE DISPOSITION — the two writers in this file.
//
// PHASE-2 progress.md, T1 adjudication #2, ruled under standing authority: the plan clause
// "going idle reconciles to PAUSED, never complete" STANDS, and it is reconciled with the
// P2 drive boundary ("an in_progress task does not EVER just get ignored") by three riders,
// all three of which are implemented here and tested beside them:
//
//   (a) the transition keys on the ENGINE's own RECORD of the turn — `turns.exit_reason` +
//       `turns.answered` + `turns.effectful_calls`, plus the delivery ledger — and NEVER on
//       the shape of the model's prose. There is no regex in this file and no text is read;
//   (b) the REOPEN edge is part of the same requirement: the owner's next ask resumes the
//       work to the exact state it was paused from;
//   (c) paused work stays visible: `status='paused'` is a status the owner sees on the
//       board and the daily brief reads (PHASE-2 T7 lands that surface), NOT the hidden
//       `deliverable_shown` flag whose invisibility was the actual complaint behind P2.
//
// WHY THE DIFFERENCE FROM `deliverable_shown` IS STRUCTURAL, not a matter of degree. The
// deleted stamp inferred DELIVERY from the coexistence of a non-empty reply and open tasks,
// applied to EVERY in_progress task, was invisible, and stood the ladder down silently.
// This pauses only when the engine holds a DELIVERY RECEIPT for the turn, only when the
// turn performed ZERO effectful calls (a turn that acted is still working — the yacht
// research hour had exec and web calls in it and would not pause here), records itself in
// `task_log`, and is undone by the owner's next word.
//
// WHERE THESE TWO WRITE (PHASE-2 T8b, the conversion T6 declared and dated): both go
// through `transition()` on the `work` spine now. The pause carries the delivery receipt it
// already held as its evidence_ref, which is what lets it be `by: 'engine'` at all (G6: the
// engine may only assert what it can point at); the reopen is the OWNER's word and says so.
// ════════════════════════════════════════════════════════════════════════════════

/** States this disposition may move FROM. The drive states, and only those. */
const DRIVE_STATES = ["'claimed'"];

export interface PauseResult { paused: number; ids: string[] }

/**
 * The turn spoke to the owner, performed nothing, and closed nothing: the ball is with the
 * person, so the work stops being driven and starts waiting — visibly.
 *
 * Returns 0 without touching anything unless ALL of these hold, each a recorded fact:
 *   * the turn record says `answered` (the truthful-answer key, not "some text existed");
 *   * a real delivery for that turn is on the ledger (the receipt);
 *   * the turn recorded ZERO effectful calls (it did not DO anything, it TALKED);
 *   * the caller did not itself transition a ticket this turn.
 * Recurring schedules are carved out: a schedule is never paused by a missed close-out
 * (janitorial, not forgery — the carve-out is carried verbatim from the going-idle
 * reconciliation this replaces).
 *
 * `touchedSince` IS THE SCOPE, and it is the difference between this and the stamp P2
 * deleted. That one marked EVERY in_progress task delivered; this one may only dispose of
 * work THIS TURN ACTUALLY TOUCHED — `updated_at` inside the turn's own window. A backlog
 * item nobody moved is not this turn's to park, it is the poke ladder's to drive, and the
 * "idle in_progress task gets driven, always" invariant survives untouched because the rows
 * it guards are exactly the rows this window excludes.
 */
export function pauseDriveWorkWaitingOnOwner(
  agentId: string, turnNumber: number | null | undefined,
  opts?: {
    transitionedThisTurn?: boolean;
    conversationId?: string | null;
    /** SQLite datetime text ('YYYY-MM-DD HH:MM:SS'). Omitted only in unit tests. */
    touchedSince?: string | null;
  },
): PauseResult {
  const none: PauseResult = { paused: 0, ids: [] };
  if (opts?.transitionedThisTurn) return none;
  const outcome = turnOutcome(agentId, turnNumber);
  if (!outcome || !outcome.answered) return none;
  if (outcome.effectfulCalls > 0) return none;
  if (!turnDeliveredToPerson(agentId, turnNumber, opts?.conversationId ?? null)) return none;

  const db = getDb();
  const since = opts?.touchedSince ?? null;
  const sinceMs = since == null ? null : tsToMs(since);
  const rows = db.prepare(
    `SELECT w.id AS id, w.state AS state FROM work w
      WHERE ${taskScope('w')}
        AND w.agent_id = ? AND w.state IN (${DRIVE_STATES.join(', ')})
        AND w.is_paused = 0 AND w.repeat_interval IS NULL
        ${sinceMs != null ? 'AND w.updated_at >= ?' : ''}
      ORDER BY w.updated_at DESC LIMIT 10`,
  ).all(...(sinceMs != null ? [agentId, sinceMs] : [agentId])) as Array<{ id: string; state: string }>;
  if (rows.length === 0) return none;

  // The receipt this whole disposition is keyed on, resolved once: it is both the reason the
  // pause is allowed and the evidence G6 requires of an engine assertion.
  const receipt = terminalDeliveryForTurn(agentId, turnNumber, opts?.conversationId ?? null);
  const ids: string[] = [];
  for (const t of rows) {
    const r = setTrackerStatus(t.id, 'paused', {
      by: receipt ? 'engine' : 'agent', actorId: agentId,
      evidenceRef: receipt,
      expectedState: t.state as WorkState,
      reason: `turn ${turnNumber} delivered a reply to the person and executed no effectful call; `
        + 'the work is waiting on them, so it stops being driven and is surfaced by aging instead',
    });
    if (r.kind === 'applied') ids.push(t.id);
  }
  if (ids.length > 0) {
    // Written SYNCHRONOUSLY, in the same tick as the disposition. An audit entry that
    // lands one microtask later is an audit entry a crash can lose, and "the pause is
    // recorded where somebody can find it" is a property this file's tests assert.
    for (const id of ids) {
      writeTaskLog({
        taskId: id, fromEntity: 'engine', entryKind: 'transition',
        fromStatus: 'in_progress', toStatus: 'paused',
        actionTaken: 'waiting on the owner (turn answered, nothing performed, nothing closed)',
        reason: `turn ${turnNumber} delivered a reply to the person and executed no effectful call; `
          + 'the work is waiting on them, so it stops being driven and is surfaced by aging instead',
      });
    }
    logger.info('turn-end disposition: drive work reconciled to paused (waiting on the owner)', {
      agentId, turnNumber, count: ids.length, ids,
    }, agentId);
  }
  return { paused: ids.length, ids };
}

export interface ResumeResult { resumed: number; ids: string[] }

/**
 * THE REOPEN EDGE (rider b). The owner said something, so work that was waiting on them is
 * waiting no longer: it returns to EXACTLY the state it was paused from.
 *
 * Keyed on `status_before_pause`, which is the engine's own record that IT paused this row.
 * A task the owner or the model paused deliberately has no such record and is never touched
 * — that distinction is the whole reason the column is written rather than assuming
 * `in_progress`.
 */
export function resumeWorkOnOwnerAsk(agentId: string): ResumeResult {
  const db = getDb();
  const rows = db.prepare(
    `SELECT w.id AS id, w.status_before_pause AS prev FROM work w
      WHERE ${taskScope('w')}
        AND w.agent_id = ? AND w.state = 'paused' AND w.status_before_pause IS NOT NULL
        AND w.is_paused = 0
      ORDER BY w.updated_at DESC LIMIT 10`,
  ).all(agentId) as Array<{ id: string; prev: string }>;
  const ids: string[] = [];
  for (const t of rows) {
    // `by: 'owner'` is the literal truth of this edge and it is what makes it legal without
    // evidence: the owner spoke, and their word is the authority G8 recognises.
    const r = setTrackerStatus(t.id, t.prev as TrackerStatus, {
      by: 'owner', actorId: 'owner', expectedState: 'paused',
      reason: 'the engine paused this because the work was waiting on the owner; they have now spoken',
    });
    if (r.kind === 'applied') ids.push(t.id);
  }
  if (ids.length > 0) {
    for (const id of ids) {
      writeTaskLog({
        taskId: id, fromEntity: 'engine', entryKind: 'transition',
        fromStatus: 'paused', toStatus: 'in_progress',
        actionTaken: 'the owner answered; the work is driving again',
        reason: 'the engine paused this because the work was waiting on the owner; they have now spoken',
      });
    }
    logger.info('reopen edge: the owner answered, so engine-paused work resumed', {
      agentId, count: ids.length, ids,
    }, agentId);
  }
  return { resumed: ids.length, ids };
}
