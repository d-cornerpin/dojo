// THE ANSWERED EDGE, the ONE place answering "has the person heard from us": the send door's
// delivery row (`work.result_delivery_id`) proves an answer, the `answer_message_id` stamp covers more.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import type { TurnExitReason } from './turn-record.js';
import { askIdForMessage } from '../../work/store.js';
// The declared not-an-answer bubbles: one owner, three readers; import it, never retype it.
import { NON_ANSWERING_DELIVERY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from '../../work/ask-settlement.js';
import { taskScope, tsToMs } from '../../work/tracker-view.js';
import { setHold, heldExpr, workingExpr } from '../../work/done/hold.js';
import { recordedInstant } from '../../memory/message-stamp.js';
import { withSessionBoundary } from '../../memory/session-boundary.js';
// Imports the withdrawal QUESTION only: no status literal, no `dojo_reports` SQL in this file.
import { answerStillStands } from '../../report/withdrawn-claim.js';

const logger = createLogger('answered-edge');

/** Deliveries that are not an ANSWER to anybody: a start line, whoever wrote it, is not a reply. */
const nonAnsweringToolsSql = (): string => [...NON_ANSWERING_DELIVERY_TOOLS].map((t) => `'${t}'`).join(', ');

export interface AnswerReceipt {
  answered: boolean;
  /** The delivery that proves it, when the spine holds one. */
  deliveryId: string | null;
  answerMessageId: string | null;
  /** True when this ask has no work row at all: only the message row exists. */
  legacyRow: boolean;
}

const NO_RECEIPT: AnswerReceipt = {
  answered: false, deliveryId: null, answerMessageId: null, legacyRow: false,
};

/** Both directions at once: `answered` true is the answer-receipt read, false the
 *  closeout-owe read. The two records are UNIONED, never ranked; why is in the body. */
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
  // UNIONED, never ranked: a stamped ask whose work row is not done-with-delivery still counts
  // as answered, the stamp is its own proof. Retire this stamp arm when the query below gives 0:
  //   SELECT count(*) FROM messages m JOIN work w ON w.root_id = m.id AND w.kind='ask'
  //    WHERE m.answer_message_id IS NOT NULL
  //      AND NOT (w.state='done' AND w.result_delivery_id IS NOT NULL);
  // Stamped asks whose work row was later abandoned WERE answered; `deliveryId` comes from the row only.
  // Absent or ambiguous evidence errs toward serving the ask again.
  const byTicket = row.state === 'done' && row.delivery_id !== null;
  const byStamp = row.answer_message_id !== null;
  return {
    answered: byTicket || byStamp,
    deliveryId: byTicket ? row.delivery_id : null,
    answerMessageId: row.answer_message_id,
    legacyRow: row.no_ticket === 1,
  };
}

export function owesAnswer(messageId: string | null | undefined): boolean {
  return !answerReceiptForAsk(messageId).answered;
}

/** PRE-SPINE FALLBACK with no birthing ask: a substantive MODEL-AUTHORED reply since this
 *  instant? Exclusions are recorded facts (a2a, `[{`, `origin_intent`, under 40 chars).
 *  The boundary is ms both sides: an INTEGER ms column vs a TEXT datetime matches nothing. */
export function substantiveReplySince(agentId: string, sinceMs: number): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM messages
      WHERE agent_id = ? AND role = 'assistant' AND created_at >= ?
        AND lane <> 'a2a'
        AND content NOT LIKE '[{%'
        AND origin_intent IS NULL
        AND length(trim(content)) > 40
      LIMIT 1`,
  ).get(agentId, sinceMs);
}

// Every read below that LISTS or QUOTES a settled ask first asks `answerStillStands`.

/** The agent's OWN recorded answer, newest settled ask only, IN THE CURRENT SESSION; the engine QUOTES it.
 *  A reset or withdrawal returns null and never falls back to an OLDER answer (never on offer). */
export function recordedAnswerInConversation(agentId: string, conversationId: string): string | null {
  const session = withSessionBoundary(agentId, 'm1.created_at');
  const r = getDb().prepare(
    `SELECT m2.content AS answer, m1.seq AS ask_seq, m2.id AS ans_id
       FROM messages m1 JOIN messages m2 ON m2.id = m1.answer_message_id
      WHERE m1.agent_id = ? AND m1.role = 'user' AND m1.conversation_id = ?
        AND m1.answer_message_id IS NOT NULL AND m2.role = 'assistant'${session.sql}
      ORDER BY m1.created_at DESC LIMIT 1`,
  ).get(agentId, conversationId, ...session.params) as
    | { answer: string; ask_seq: number; ans_id: string }
    | undefined;
  if (!r) return null;
  if (!answerStillStands(agentId, r.ask_seq, r.ans_id)) return null;
  return r.answer;
}

// The prompt-assembly reads of this edge; the epoch-ms date type is handled ONCE, here.

/** How many settled asks the engine names; the recall lane uses this same number. */
export const RECENTLY_ANSWERED_LIMIT = 3;

export interface AnsweredAsk {
  askId: string;
  askContent: string;
  /** Epoch ms INTEGER, not a SQLite datetime string. */
  askAt: number;
}

/** The last `limit` stamped asks of ONE conversation, IN THE CURRENT SESSION: a settled-question
 *  ledger, not a search; it crosses no conversation or session boundary (`session-boundary.ts`)
 *  and never says what the answer was; withdrawals SHORTEN the list, never extend its reach. */
export function recentlyAnsweredAsks(
  agentId: string, conversationId: string, limit: number,
): AnsweredAsk[] {
  const session = withSessionBoundary(agentId);
  const rows = getDb().prepare(
    `SELECT id, content, created_at, seq, answer_message_id FROM messages
      WHERE agent_id = ? AND conversation_id = ? AND role = 'user'
        AND answer_message_id IS NOT NULL${session.sql}
      ORDER BY created_at DESC LIMIT ?`,
  ).all(agentId, conversationId, ...session.params, limit) as Array<{
    id: string; content: string; created_at: number; seq: number; answer_message_id: string;
  }>;
  return rows
    .filter((r) => answerStillStands(agentId, r.seq, r.answer_message_id))
    .map((r) => ({ askId: r.id, askContent: r.content, askAt: r.created_at }));
}

// A pure function of its rows with NO clock: relative time would change bytes each bucket and re-bill
// the cached tail behind this block. It states the recorded instant instead.

const ANSWERED_EXCERPT_CHARS = 90;

export const RECENTLY_ANSWERED_HEAD =
  'RECENTLY ANSWERED in this conversation (engine record; do NOT re-execute this work. If '
  + "asked about it again, a brief restatement of the answer's content is fine, or point at "
  + 'the earlier answer; never silence, and never re-run the work itself):';

export function renderRecentlyAnsweredBlock(asks: readonly AnsweredAsk[]): string | null {
  if (asks.length === 0) return null;
  const lines = asks.map((a) => {
    const excerpt = a.askContent.replace(/^\[[^\]]*\]\s*/g, '').trim().slice(0, ANSWERED_EXCERPT_CHARS);
    return `- answered ${recordedInstant(a.askAt)}: "${excerpt}"`;
  });
  return `${RECENTLY_ANSWERED_HEAD}\n${lines.join('\n')}`;
}

export interface AnsweredPair {
  askId: string;
  askContent: string;
  askAt: number;
  answerId: string;
  answerContent: string;
  answerAt: number;
}

/** Resolve any given message id, ask half or answer half, to its ANSWERED PAIR; `agent_id` binds
 *  both halves. ONE object per pair lives under BOTH ids for caller dedup; withdrawn pairs drop. */
export function answeredPairsForMessages(
  agentId: string, messageIds: readonly string[],
): Map<string, AnsweredPair> {
  const out = new Map<string, AnsweredPair>();
  if (messageIds.length === 0) return out;
  const marks = messageIds.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT ask.id AS ask_id, ask.content AS ask_content, ask.created_at AS ask_at,
            ans.id AS ans_id, ans.content AS ans_content, ans.created_at AS ans_at,
            ask.seq AS ask_seq
       FROM messages ask JOIN messages ans ON ans.id = ask.answer_message_id
      WHERE ask.agent_id = ? AND ans.agent_id = ?
        AND ask.role = 'user' AND ans.role = 'assistant'
        AND (ask.id IN (${marks}) OR ans.id IN (${marks}))`,
  ).all(agentId, agentId, ...messageIds, ...messageIds) as Array<{
    ask_id: string; ask_content: string; ask_at: number;
    ans_id: string; ans_content: string; ans_at: number; ask_seq: number;
  }>;
  for (const r of rows) {
    if (!answerStillStands(agentId, r.ask_seq, r.ans_id)) continue;
    const pair: AnsweredPair = {
      askId: r.ask_id, askContent: r.ask_content, askAt: r.ask_at,
      answerId: r.ans_id, answerContent: r.ans_content, answerAt: r.ans_at,
    };
    out.set(r.ask_id, pair);
    out.set(r.ans_id, pair);
  }
  return out;
}


/** The question is "is a delivery on the ledger for this turn", never how the text looks: every
 *  door records a receipt. Bubbles are excluded via NOT EXISTS over the declared kinds; a
 *  receipt with no message row still counts; `conversationId` narrows to the addressee. */
export function turnDeliveredToPerson(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): boolean {
  if (turnNumber == null) return false;
  const db = getDb();
  const scoped = conversationId != null;
  const chipKinds = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  const hit = db.prepare(
    `SELECT 1 AS ok FROM deliveries d
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered'
        AND d.channel <> 'a2a'
        AND d.tool NOT IN (${nonAnsweringToolsSql()})
        AND NOT EXISTS (SELECT 1 FROM messages m
                         WHERE m.id = d.message_id AND m.display_kind IN (${chipKinds}))
        ${scoped ? 'AND d.conversation_id = ?' : 'AND d.conversation_id IS NOT NULL'}
      LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { ok: number } | undefined;
  return hit !== undefined;
}

/** The delivery the truthful-answer key points at, from this ledger; newest send wins. */
export function terminalDeliveryForTurn(
  agentId: string, turnNumber: number | null | undefined, conversationId?: string | null,
): string | null {
  if (turnNumber == null) return null;
  const scoped = conversationId != null;
  const r = getDb().prepare(
    `SELECT id FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered'
        AND channel <> 'a2a'
        AND tool NOT IN (${nonAnsweringToolsSql()})
        ${scoped ? 'AND conversation_id = ?' : 'AND conversation_id IS NOT NULL'}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(...(scoped ? [agentId, turnNumber, conversationId] : [agentId, turnNumber])) as
    { id: string } | undefined;
  return r?.id ?? null;
}


export interface ClosedWithoutDelivery {
  workId: string;
  kind: string;
  title: string | null;
  rootId: string;
  state: string;
  conversationId: string | null;
}

/** Nothing delivered for it: only `failed`/`abandoned` close silently (DDL CHECK). */
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


export interface ClaimedWork {
  workId: string;
  kind: string;
  title: string | null;
  conversationId: string | null;
  claimedByTurn: number | null;
  rootId: string;
}

/** Claimed work, each row carrying its conversation: the identity to escalate comes back with it. */
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

// THE DISPOSITION, the only writer here: keys on the ENGINE's own records, NEVER on the shape
// of prose. A pause is a VISIBLE hold on the board, recorded on the task's trail, reopened explicitly.

export interface PauseResult { paused: number; ids: string[] }

/** The request a continuation chain serves: a continuation's turn record carries no root, so
 *  walk back over rootless same-conversation turns to the one that served a row. Bounded. */
function servedRequestOfContinuation(agentId: string, turnNumber: number | null | undefined): string | null {
  if (turnNumber == null) return null;
  const stmt = getDb().prepare(
    'SELECT subject_kind, root_kind, source_message_id, conv_key FROM turns WHERE agent_id = ? AND turn_number = ?',
  );
  const first = stmt.get(agentId, turnNumber) as
    { subject_kind: string | null; root_kind: string | null; source_message_id: string | null; conv_key: string | null } | undefined;
  if (!first || first.root_kind !== null || !['conv', 'continuation'].includes(first.subject_kind ?? '')) return null;
  for (let t = turnNumber - 1, hops = 0; t > 0 && hops < 50; t--, hops++) {
    const r = stmt.get(agentId, t) as typeof first;
    if (!r || r.conv_key !== first.conv_key) return null;
    if (r.source_message_id) return r.source_message_id;
    if (r.root_kind !== null) return null;
  }
  return null;
}

/** Returns 0 unless ALL hold, each a recorded fact: the turn record says `answered`; a real
 *  delivery for that turn is on the ledger; ZERO effectful calls; the caller transitioned
 *  nothing; recurring schedules never pause. `touchedSince` IS THE SCOPE: only touched work. */
export function pauseDriveWorkWaitingOnOwner(
  agentId: string, turnNumber: number | null | undefined,
  opts?: {
    transitionedThisTurn?: boolean;
    conversationId?: string | null;
    /** SQLite datetime text ('YYYY-MM-DD HH:MM:SS'). Omitted only in unit tests. */
    touchedSince?: string | null;
    delegatedThisTurn?: boolean;
    queuedOwnContinuation?: boolean;
    startLineOnly?: boolean;
    trackerWriteThisTurn?: boolean;
    /** The message row this turn SERVED; only work linked to it can await its sender's answer. */
    servedSourceMessageId?: string | null;
  },
): PauseResult {
  const none: PauseResult = { paused: 0, ids: [] };
  if (opts?.transitionedThisTurn) return none;
  // A DELEGATING TURN did ACT (opened a delegation join): work waits on the PIECES, not the owner.
  if (opts?.delegatedThisTurn) return none;
  // A turn that queued its own continuation is still WORKING, not waiting on a person.
  if (opts?.queuedOwnContinuation) return none;
  // A turn judged multi-step work that only said it was starting: the next move is the AGENT's.
  if (opts?.startLineOnly) return none;
  // A tracker write (a note, an edit, an open) means the turn ACTED on its own record.
  if (opts?.trackerWriteThisTurn) return none;
  const outcome = turnOutcome(agentId, turnNumber);
  if (!outcome || !outcome.answered) return none;
  if (outcome.effectfulCalls > 0) return none;
  if (!turnDeliveredToPerson(agentId, turnNumber, opts?.conversationId ?? null)) return none;

  const db = getDb();
  const since = opts?.touchedSince ?? null;
  const sinceMs = since == null ? null : tsToMs(since);
  // A turn that served nothing answered no person, so it cannot have handed the ball back; and
  // a task THIS turn OPENED is contradicted by parking it in the same breath. Both are rows.
  const served = db.prepare('SELECT subject_kind FROM turns WHERE agent_id = ? AND turn_number = ?')
    .get(agentId, turnNumber) as { subject_kind: string | null } | undefined;
  if (served && served.subject_kind === 'none') return none;
  // ONLY WORK LINKED TO THE ROW THIS TURN SERVED: its sender is the one a reply could await.
  // No automatic reopen exists, so a misfiring pause STRANDS work; `null` walks the chain.
  const servedId = opts?.servedSourceMessageId === null
    ? servedRequestOfContinuation(agentId, turnNumber)
    : opts?.servedSourceMessageId;
  if (servedId === null) return none;
  const linkClause = servedId !== undefined ? 'AND w.source_message_id = ?' : '';
  const params: unknown[] = [agentId, turnNumber ?? -1];
  if (servedId !== undefined) params.push(servedId);
  if (sinceMs != null) params.push(sinceMs);
  const rows = db.prepare(
    `SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')}
        AND w.agent_id = ? AND ${workingExpr('w')}
        AND NOT ${heldExpr('w')} AND w.repeat_interval IS NULL
        AND (w.origin_turn IS NULL OR w.origin_turn <> ?)
        ${linkClause}
        ${sinceMs != null ? 'AND w.updated_at >= ?' : ''}
      ORDER BY w.updated_at DESC LIMIT 10`,
  ).all(...params) as Array<{ id: string }>;

  const ids = rows.map((t) => t.id).filter((id) => setHold(id, 'paused', 'Waiting for a reply to its last message.', 'engine').ok);
  if (ids.length > 0) {
    logger.info('turn-end disposition: drive work held paused (waiting on the owner)', {
      agentId, turnNumber, count: ids.length, ids,
    }, agentId);
  }
  return { paused: ids.length, ids };
}

// A pause is reopened ONLY by an explicit status change; a task waiting on the owner stays on the list
// labelled waiting, and when the owner's message is the answer the AGENT resumes it with `work_update`.
