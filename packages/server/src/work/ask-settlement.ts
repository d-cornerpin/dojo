// Settlement authority for owner asks: ONE function (`settleAsk`) decides whether an ask is settled. An ask
// closes only against a DELIVERED delivery in its own conversation that the ask entered the model's context
// before, and only if the row has no unresolved delegation. With no qualifying delivery it goes `open`,
// never left `claimed`. Ambiguous evidence errs toward serving the ask again, never toward silence. A turn
// that ran a non-idempotent tool and delivered nothing still hands its ask back (`handBackAsk`), so the
// re-serve may repeat that call (the reason names the turn).
// The wrappers below carry scope only; the join and async arms are the same rule.

import { getDb } from '../db/connection.js';
import { dueAfterCut, handBackCauseOf, turnExitReason } from './exit-attribution.js';
import { createLogger } from '../logger.js';
import { TERMINAL_JOB_STATUS_SQL } from '../services/media-job-status.js';
import { turnContext } from '../agent/turn-context.js';
import { onTaskEnded } from './task-ended.js';
import { ENGINE_SCAFFOLD_ROOT_KIND, PARKED_JOB_TITLE, handedInExpr, heldByOwnerSql } from './tracker-view.js';
import { delegatedRelayEvidence, turnEndedInModelSilence } from './delegated-relay-evidence.js';
import { recordServingTurnByRowid } from '../memory/message-store.js';
// Imported from the leaf: `NOT_A_START_ACK` reads it at module scope, and `message-store` reaches this
// file through its own graph, so importing it from there could read it before it is initialized.
import { START_ACK_ORIGIN_INTENT } from '../memory/origin-intents.js';
import { afterCommit } from '../db/unit.js';
import { broadcast } from '../gateway/ws.js';
import { announceAgentLiveWork, serveLater } from '../agent/v2/serve-later.js';
import { recordFloorGhost } from '../agent/v2/floor-ghost.js';
import {
  appendWorkEvent, askIdForMessage, claimAsk, claimingTurnOf, failJoinClosed, firstServedAt, isTerminal, stampClaimingTurn,
  transition,
  type WorkState,
} from './store.js';

const logger = createLogger('ask-settlement');

/** Tools whose delivery is not an answer. */
export const NON_ANSWERING_DELIVERY_TOOLS = new Set(['engine-ack', 'cannot-run', 'download-links']);

/** `display_kind`s whose delivery is not a reply: a tool-call chip (`tool-turn`) and a `working-note`.
 *  Keyed on the delivery's own message row, so a send with no message id is untouched. */
export const NON_ANSWERING_DISPLAY_KINDS = ['tool-turn', 'working-note'] as const;

/** The tool the engine records when it relays a delegated answer to the owner; no model can call it.
 *  Declared above the predicates because `NOT_A_SUPERSEDED_BUBBLE` reads it at module scope.
 *  `a2a-join-failed` (a no-answer notice) and `a2a-join-late` (it has its own arm) are absent on purpose. */
export const ENGINE_JOIN_RELAY_TOOLS = new Set(['a2a-join-relay']);

/** A reply to the request `w` is on its way: a queued answering row of the turn that claimed it, in its
 *  conversation, or one that carries it as its `joinId` (a relay). A start line alone is not a reply. */
export const REPLY_IN_FLIGHT =
  `EXISTS (SELECT 1 FROM deliveries rf WHERE rf.outcome = 'pending' AND rf.payload_json IS NOT NULL
      AND json_valid(rf.payload_json) AND rf.tool NOT IN (${[...NON_ANSWERING_DELIVERY_TOOLS].map((t) => `'${t}'`).join(', ')})
      AND ((rf.agent_id = w.agent_id AND rf.turn_number = w.claimed_by_turn AND rf.conversation_id = w.conversation_id)
           OR json_extract(rf.payload_json, '$.joinId') = w.id))`;

/** A request closes only on a row of its own channel; a dashboard, voice or phone request (live) also on the
 *  dashboard copy of its reply. Over the delivery `d`. */
export const CHANNEL_MATCHES =
  `EXISTS (SELECT 1 FROM conversations cm WHERE cm.id = d.conversation_id
      AND (cm.channel IN ('dashboard', 'voice', 'phone') OR cm.channel = d.channel))`;

export function replyInFlight(askId: string): boolean {
  return getDb().prepare(`SELECT 1 FROM work w WHERE w.id = ? AND ${REPLY_IN_FLIGHT}`).get(askId) !== undefined;
}

/** Where in the lifecycle the question is asked; it selects the no-evidence tie-break. `join` and `async`
 *  differ in evidence: the delivery must postdate `join_complete`, or be a background job's result. */
export type SettlementMoment = 'delivery' | 'finalize' | 'boot' | 'join' | 'async';

export type AskSettlementVerdict = 'closed' | 'held' | 'reopened' | 'unchanged';

export interface AskSettlementOutcome {
  workId: string;
  verdict: AskSettlementVerdict;
  deliveryId: string | null;
  detail: string;
}

export interface SettlementContext extends TurnEnd {
  agentId: string;
  turnNumber: number | null;
  at: SettlementMoment;
  /** The ask's own message row; settling stamps `messages.served_by_turn` with it as part of closing. */
  rowid?: number | null;
  actorId?: string | null;
  /** The agent NAMED this inherited ask answered (`kept` through the tracker door); the engine checks it. */
  inheritedKept?: true;
  /** JOIN MOMENT ONLY: the delivery the relay just recorded; it is still checked against the evidence. */
  deliveryId?: string | null;
  reason?: string;
  /** JOIN MOMENT ONLY: selects the delivery boundary. `compiled` and `engine-relay` (named apart for the
   *  `compile_resolved` record): children settled, delivery postdates `join_complete`. `late-answer`: the
   *  join failed closed, so the boundary is the ask's arrival; `failed -> open` guards exactly-once. */
  basis?: 'compiled' | 'engine-relay' | 'late-answer';
  /** FINALIZE ONLY: the ask's message only declined or acknowledged, so the model's silence settles it. */
  askedNothing?: boolean;
}

/** How the turn ended, beyond its exit word: the provider's reset it met, paid calls before it, the task it parked
 *  its job on, whether it was started from a parked job, and whether its required reply came back with nothing. */
export interface TurnEnd {
  retryAt?: number | null; paidBeforeLimit?: boolean; parkedTask?: string | null; jobTurn?: boolean; forcedEmpty?: boolean;
}

interface AskRow {
  id: string;
  agent_id: string;
  kind: string;
  state: WorkState;
  conversation_id: string | null;
  opened_at: number;
  root_id: string;
  remaining_children: number | null;
  compile_pending: number;
  claimed_by_turn: number | null;
  result_delivery_id: string | null;
}

function readAsk(workId: string): AskRow | undefined {
  return getDb().prepare(
    `SELECT id, agent_id, kind, state, conversation_id, opened_at, root_id,
            remaining_children, compile_pending, claimed_by_turn, result_delivery_id
       FROM work WHERE id = ?`,
  ).get(workId) as AskRow | undefined;
}

/** The evidence: a delivered send in the ask's own conversation, on the adjudicated turn, postdating the
 *  ask's arrival (whole seconds: `deliveries.created_at` is seconds, `work.opened_at` is epoch-ms). */
function qualifyingDelivery(
  ask: AskRow, turnNumber: number | null,
): { id: string; tool: string } | null {
  if (turnNumber == null || ask.conversation_id == null) return null;
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = ? AND d.turn_number = ? AND d.conversation_id = ?
        AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND ${NOT_A_TOOL_CHIP}
        AND ${NOT_A_SUPERSEDED_BUBBLE}
        AND ${NOT_A_START_ACK}
        AND ${NOT_OWED_PAST_THIS_DELIVERY}
        AND ${CHANNEL_MATCHES}
        AND unixepoch(d.created_at) >= ?
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(ask.agent_id, turnNumber, ask.conversation_id, ...excluded,
    ask.id, turnNumber, Math.floor(ask.opened_at / 1000)) as
    { id: string; tool: string } | undefined) ?? null;
}

/** The same evidence read, exported for `ask-remediation.ts` (terminal rows `settleAsk` refuses). */
export function askAnswerEvidence(
  workId: string, turnNumber: number | null,
): { id: string; tool: string } | null {
  const ask = readAsk(workId);
  if (!ask || ask.kind !== 'ask') return null;
  return qualifyingDelivery(ask, turnNumber);
}

/** SQL fragment shared by the delivery and join arms; literal so it prepares under the conformance walk. */
const NOT_A_TOOL_CHIP =
  `NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND m.display_kind IN (${
    NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ')}))`;

/** After the serving turn ends, the only model bubble that can be the receipt is the one the turn names its
 *  answer (`turns.answer_message_id`). Not reached: sends with no message row, the engine's join relay, and
 *  turns still running or `terminated`. */
const NOT_A_SUPERSEDED_BUBBLE =
  `NOT EXISTS (
     SELECT 1 FROM messages mb
       JOIN turns tb ON tb.agent_id = d.agent_id AND tb.turn_number = d.turn_number
      WHERE mb.id = d.message_id
        AND mb.role = 'assistant' AND mb.display_kind = 'agent-text'
        AND d.tool NOT IN (${[...ENGINE_JOIN_RELAY_TOOLS].map((t) => `'${t}'`).join(', ')})
        AND tb.ended_at IS NOT NULL AND tb.exit_reason IS NOT 'terminated'
        AND (tb.answer_message_id IS NULL OR tb.answer_message_id <> d.message_id))`;

/** A start-ack is not an answer. The engine marks it with `origin_intent` (`START_ACK_ORIGIN_INTENT`), so
 *  this holds at delivery time with no turn record. Refusing it cannot park the ask: it stays `claimed`
 *  until the real answer closes it, or the boot arms hand it back open. */
const NOT_A_START_ACK =
  `NOT EXISTS (SELECT 1 FROM messages ma WHERE ma.id = d.message_id
                 AND ma.origin_intent = '${START_ACK_ORIGIN_INTENT}')`;

/** Every delivery tool the engine writes rather than the agent. An unscoped door crossing is written as
 *  `<channel>-door` and excluded by pattern in the read. */
export const ENGINE_SENT_TOOLS: ReadonlySet<string> = new Set([
  ...NON_ANSWERING_DELIVERY_TOOLS, ...ENGINE_JOIN_RELAY_TOOLS, 'a2a-join-failed', 'a2a-join-late',
  'alert', 'owner-card', 'owner-close', 'oobe-welcome', 'healer-approval', 'busy-ack',
]);

/** The `audit` marker the inherited-backlog park writes (`work/inherited-backlog.ts`); read here. */
export const INHERITED_BACKLOG_MARKER = 'inherited_backlog';

/** A real answer the agent delivered in `conversationId` since `notBefore` (no turn match): never an
 *  engine-sent row, a chip or a start-ack. Shared by the remediation triage and the inherited-ask close. */
export function realAnswerInConversationSince(
  agentId: string, conversationId: string | null, notBefore: string,
): { id: string; tool: string } | null {
  if (conversationId == null) return null;
  const excluded = [...ENGINE_SENT_TOOLS];
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = ? AND d.conversation_id = ? AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND d.tool NOT LIKE '%-door' AND ${NOT_A_TOOL_CHIP} AND ${NOT_A_START_ACK} AND ${CHANNEL_MATCHES}
        AND d.created_at >= ?
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(agentId, conversationId, ...excluded, notBefore) as { id: string; tool: string } | undefined) ?? null;
}

function inheritedParkedAt(workId: string): string | null {
  const r = getDb().prepare(
    `SELECT created_at AS at FROM work_events WHERE work_id = ? AND kind = 'audit'
       AND json_extract(payload, '$.marker') = ? ORDER BY id DESC LIMIT 1`,
  ).get(workId, INHERITED_BACKLOG_MARKER) as { at: number } | undefined;
  return r ? sqlTime(r.at) : null;
}
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const JOB_HOLD_REASON = 'held: its job is still running';
/** When the request was held on its job and the task it names, if that hold is its latest transition. */
export function jobHeldAt(workId: string): { at: string; task: string | null } | null {
  const r = getDb().prepare(`SELECT created_at AS at, json_extract(payload, '$.reason') AS why, json_extract(payload, '$.evidence_ref') AS task
    FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id DESC LIMIT 1`)
    .get(workId) as { at: number; why: string | null; task: string | null } | undefined;
  return r?.why?.startsWith(JOB_HOLD_REASON) ? { at: sqlTime(r.at), task: r.task } : null;
}

/** Is task `id` still open, and is it parked (a due time set)? */
function taskNow(id: string): { open: boolean; parked: boolean } {
  const r = getDb().prepare('SELECT state, next_attempt_at AS due FROM work WHERE id = ?').get(id) as { state: WorkState; due: number | null } | undefined;
  return { open: !!r && !isTerminal(r.state), parked: r?.due != null };
}

/** A delivery at or below the rowid high-water `recordOwedInterruptSubjects` stored for this ask predates
 *  the re-prompt that told the model it was still owed. Rowid, not the clock: `created_at` is whole seconds
 *  and can tie. Refusing it cannot park the ask: finalize hands it back open. */
const NOT_OWED_PAST_THIS_DELIVERY =
  `NOT EXISTS (SELECT 1 FROM work_events oi
                WHERE oi.work_id = ? AND oi.kind = 'owed_interrupt'
                  AND json_extract(oi.payload, '$.turnNumber') = ?
                  AND d.rowid <= json_extract(oi.payload, '$.deliveryHighWater'))`;

/** The owed-interrupt receipt, written here because `work/` is the spine's single writer and read by the
 *  narrowing above. Best-effort: an owed message with no ask row is skipped; a failure must not cost
 *  the re-prompt. */
export function recordOwedInterruptSubjects(
  agentId: string, owedMessageIds: readonly string[], turnNumber: number,
): void {
  if (owedMessageIds.length === 0) return;
  const db = getDb();
  const water = (db.prepare(
    'SELECT COALESCE(MAX(rowid), 0) AS water FROM deliveries WHERE agent_id = ?',
  ).get(agentId) as { water: number }).water;
  for (const messageId of owedMessageIds) {
    const workId = askIdForMessage(messageId);
    const exists = db.prepare('SELECT 1 FROM work WHERE id = ?').get(workId);
    if (!exists) continue;
    appendWorkEvent(workId, 'owed_interrupt', 'engine', { turnNumber, deliveryHighWater: water });
    logger.info('owed mid-turn ask recorded on its own ledger: this turn\'s earlier deliveries are not its answer', {
      agentId, workId, turnNumber, deliveryHighWater: water,
    }, agentId);
  }
}

/** Is the receipt a bubble the finished turn does not call its answer? Same fragment as the evidence. */
function receiptIsASupersededBubble(ask: AskRow, turnNumber: number | null): boolean {
  if (turnNumber == null || ask.result_delivery_id == null) return false;
  return getDb().prepare(
    `SELECT 1 AS hit FROM deliveries d
      WHERE d.id = ? AND d.agent_id = ? AND d.turn_number = ?
        AND NOT (${NOT_A_SUPERSEDED_BUBBLE}) LIMIT 1`,
  ).get(ask.result_delivery_id, ask.agent_id, turnNumber) !== undefined;
}

// THE ONE COUNTER: the row's `audit` events with their cause (none = silence). Past its group's bound an ask is held
// `blocked`: owed and visible, out of the open queue, and the owner is told once on its own record.

export const MAX_ASK_RE_SERVES = 3;
export const MAX_ENGINE_HAND_BACKS = 5;
const WAIT_FIRST_MS = 60_000;

// 'wait': the provider's own reset, never counted; 'free': an exit that was nobody's failure (preempt, budget, a stop
// that ended nothing), re-opened at once and never counted.
export type HandBackCause = 'silence' | 'cut' | 'crash' | 'wait' | 'free';
type CountGroup = 'silence' | 'engine';

/** The `audit` marker the counter counts (see `join-drive.ts`). */
export const RE_SERVE_MARKER = 'ct0_ask_re_served';

/** How many hand-backs of this group the row has already spent. A COUNT over the log. */
function reServesSpent(workId: string, group: CountGroup): number {
  try {
    return (getDb().prepare(
      `SELECT COUNT(*) AS n FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.marker') = ?
          AND COALESCE(json_extract(payload, '$.cause'), 'silence') IN (${group === 'silence' ? "'silence'" : "'cut', 'crash'"})`,
    ).get(workId, RE_SERVE_MARKER) as { n: number } | undefined)?.n ?? 0;
  } catch (err) {
    // A counter that cannot be read counts as spent: hold the ask rather than re-serve it for ever.
    logger.warn('ask re-serve ladder: could not read its own counter; treating it as spent', {
      workId, error: err instanceof Error ? err.message : String(err),
    });
    return Number.MAX_SAFE_INTEGER;
  }
}

function recordReServe(workId: string, attempt: number, cause: HandBackCause, why: string): void {
  const bound = (cause === 'silence' ? MAX_ASK_RE_SERVES : MAX_ENGINE_HAND_BACKS) + 1;
  appendWorkEvent(workId, 'audit', 'ask-settlement', {
    marker: RE_SERVE_MARKER, attempt, bound, cause,
    reason: `the ask was handed back to be served again (${attempt + 1} of ${bound}): ${why}`,
  });
}

function standDownReServe(
  ask: AskRow, ctx: Pick<SettlementContext, 'agentId' | 'turnNumber'>, actorId: string, spent: number,
  out: (v: AskSettlementVerdict, d: string, id?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  const reason = `re-serve stood down after ${spent + 1} serves: turn ${ctx.turnNumber ?? '?'} finalized `
    + 'without delivering an answer, as the ones before it did. The ask is NOT answered and is '
    + 'NOT closed — it is held OWED and stays in front of the agent, but the drain will stop '
    + 'serving the same question into the same silence';
  if (ask.state === 'blocked') return out('held', 'already held: the re-serve ladder is spent');
  const r = transition(ask.id, {
    to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason,
  });
  if (r.kind !== 'applied') return out('unchanged', `stand-down refused: ${r.kind}`);
  tellOwnerStoodDown(ask, ctx.turnNumber, spent + 1);
  // `warn`: the bound working, not a fault, but a person is unanswered; `reServesSpent`'s fault path must
  // never log quieter. Pinned by `work/__tests__/the-stand-down-is-the-bound-working-not-a-fault.test.ts`.
  logger.warn('ask re-serve bound reached: the agent did not answer within its serve budget, so the ask is now HELD owed and will stop being re-served', {
    agentId: ask.agent_id, workId: ask.id, serves: spent + 1, bound: MAX_ASK_RE_SERVES + 1,
    turnNumber: ctx.turnNumber,
  }, ask.agent_id);
  return out('held', reason);
}

/** The owner is told once, on the request's own record, that the agent stopped trying it. */
function tellOwnerStoodDown(ask: AskRow, turnNumber: number | null, tries: number): void {
  if (getDb().prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'
    AND json_extract(payload, '$.floor') = 'request-stood-down'`).get(ask.id)) return;
  const r = getDb().prepare(
    `SELECT a.name AS agent, m.content AS content, c.counterparty_name AS who FROM agents a
       LEFT JOIN messages m ON m.id = ? AND m.agent_id = a.id LEFT JOIN conversations c ON c.id = ? WHERE a.id = ?`,
  ).get(ask.root_id, ask.conversation_id, ask.agent_id) as { agent: string; content: string | null; who: string | null } | undefined;
  const who = r?.who ?? 'the person';
  recordFloorGhost({
    agentId: ask.agent_id, turnNumber, floor: 'request-stood-down', workId: ask.id, attempts: tries,
    ownerLine: `${r?.agent ?? ask.agent_id} could not answer ${who}'s message ("${(r?.content ?? '').slice(0, 80)}") after ${tries} tries, `
      + `so it has stopped trying. It answers when ${who} writes again.`,
  }, { broadcast });
}

/** THE ONE HAND-BACK of a request the turn did not answer. Counts it (unless the provider asked us to wait), stands it
 *  down at its bound, else re-opens it and says when it may be served again. */
export function handBackAsk(workId: string, p: { agentId: string; turnNumber: number | null; cause: HandBackCause;
  retryAt?: number | null; actorId: string; reason: string }): AskSettlementOutcome {
  const out = (verdict: AskSettlementVerdict, detail: string): AskSettlementOutcome => ({ workId, verdict, deliveryId: null, detail });
  const ask = readAsk(workId);
  if (!ask || ask.kind !== 'ask' || isTerminal(ask.state)) return out('unchanged', 'not a live ask');
  const group: CountGroup = p.cause === 'silence' ? 'silence' : 'engine';
  const counted = p.cause !== 'wait' && p.cause !== 'free';
  const spent = counted ? reServesSpent(workId, group) : 0;
  const bound = group === 'silence' ? MAX_ASK_RE_SERVES : MAX_ENGINE_HAND_BACKS;
  if (counted && spent >= bound) return standDownReServe(ask, { agentId: p.agentId, turnNumber: p.turnNumber }, p.actorId, spent, out);
  if (ask.state !== 'open') {
    const reason = counted ? `${p.reason} (serve ${spent + 2} of ${bound + 1})` : p.reason;
    const r = transition(workId, { to: 'open', by: 'agent', actorId: p.actorId, expectedState: ask.state, reason });
    if (r.kind !== 'applied') return out('unchanged', `hand-back refused: ${r.kind}`);
  }
  if (counted) recordReServe(workId, spent + 1, p.cause, p.reason);
  const backoff = Date.now() + Math.min(WAIT_FIRST_MS * 2 ** Math.max(0, spent - (p.cause === 'crash' ? 1 : 0)), 3_600_000);
  const at = p.cause === 'wait' ? (p.retryAt ?? Date.now() + WAIT_FIRST_MS)
    : p.cause === 'silence' || p.cause === 'free' ? null
    : p.cause === 'crash' && spent === 0 ? Date.now()
    : dueAfterCut(backoff, p.retryAt);
  if (at !== null) serveLater({ kind: 'ask', id: workId }, at, p.reason);
  if (p.cause === 'wait' && p.retryAt && p.retryAt - (firstServedAt(workId) ?? Date.now()) >= 120_000) {
    const retryAt = p.retryAt;
    afterCommit(() => void import('../agent/v2/honest-stop-notes.js')
      .then(({ tellCannotRun, providerWaitWords }) => tellCannotRun(ask.agent_id, ask.root_id, providerWaitWords(ask.agent_id, retryAt))));
  }
  return out('reopened', p.reason);
}

/** The person wrote again (`triggerWorkId`, never served before): each request of that conversation stood down
 *  with nothing outstanding is claimed by this turn, so the turn's end settles it with the new message. An
 *  inherited ask stays parked; it closes only through its own door. */
export function liftStandDowns(agentId: string, triggerWorkId: string, turnNumber: number): void {
  const held = getDb().prepare(`SELECT h.id AS id FROM work h JOIN work t ON t.id = ? AND t.conversation_id = h.conversation_id
    WHERE h.agent_id = ? AND h.kind = 'ask' AND h.state = 'blocked'`).all(triggerWorkId, agentId) as Array<{ id: string }>;
  for (const { id } of held) {
    const ask = readAsk(id);
    if (!ask || joinOutstanding(ask) || mediaJobs(ask.root_id).out > 0 || stillOwed(ask, null) || inheritedParkedAt(id)) continue;
    if (transition(id, { to: 'open', by: 'agent', actorId: 'engine', expectedState: 'blocked', reason: 'the person wrote again' }).kind !== 'applied') continue;
    if (claimAsk(id, agentId).kind === 'applied') stampClaimingTurn(id, turnNumber);
  }
}

/** Once the turn is over, its reply to this ask's conversation that ended failed on its channel, or was held with no
 *  way to send it. While the turn still runs a later answer may yet go, so a failed verdict waits for finalize. */
function undeliveredReply(ask: AskRow, turnNumber: number | null, atVerdict: boolean): { id: string; outcome: string; detail: string | null } | null {
  if (turnNumber == null || ask.conversation_id == null) return null;
  if (atVerdict && !getDb().prepare('SELECT 1 FROM turns WHERE agent_id = ? AND turn_number = ? AND ended_at IS NOT NULL')
    .get(ask.agent_id, turnNumber)) return null;
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  return (getDb().prepare(
    `SELECT id, outcome, detail FROM deliveries
      WHERE agent_id = ? AND turn_number = ? AND conversation_id = ? AND tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND ((outcome = 'failed' AND payload_json IS NOT NULL) OR outcome = 'held')
      ORDER BY rowid DESC LIMIT 1`,
  ).get(ask.agent_id, turnNumber, ask.conversation_id, ...excluded) as { id: string; outcome: string; detail: string | null } | undefined) ?? null;
}

function joinOutstanding(ask: AskRow): boolean {
  return (ask.remaining_children ?? 0) > 0 || ask.compile_pending === 1;
}

/** The authority: every ask transition into `done`, and every decision not to, goes through here.
 *  Arm order: terminal; async; join; join hold; job hold; evidence; reply in flight; reply undelivered or held; then the
 *  no-evidence arms. In flight sits below evidence: an answer delivered on the request's own channel closes it
 *  even while a second reply waits. */
export function settleAsk(workId: string, ctx: SettlementContext): AskSettlementOutcome {
  const actorId = ctx.actorId ?? ctx.agentId;
  const out = (verdict: AskSettlementVerdict, detail: string, deliveryId: string | null = null):
  AskSettlementOutcome => ({ workId, verdict, deliveryId, detail });

  const ask = readAsk(workId);
  if (!ask) return out('unchanged', 'no such work row');
  if (ask.kind !== 'ask') return out('unchanged', `not an ask (kind=${ask.kind})`);

  // An inherited ask (parked `blocked` at the version boundary, its claiming turn dead) closes only when the
  // agent names it `kept` (`inheritedAskDoor`) and a real delivery exists in its conversation since then.
  const parkedAt = ask.state === 'blocked' && ctx.inheritedKept === true ? inheritedParkedAt(workId) : null;
  if (ctx.inheritedKept === true) {
    if (parkedAt === null) return out('unchanged', 'not an inherited owed ask');
    const late = realAnswerInConversationSince(ask.agent_id, ask.conversation_id, parkedAt);
    if (!late) return out('unchanged', 'inherited and owed: no real answer in its conversation since it was parked');
    const r = transition(workId, {
      to: 'done', by: 'agent', actorId, resultDeliveryId: late.id, expectedState: 'blocked',
      reason: `answered late via ${late.tool}, after it was inherited owed from an older version`,
    });
    return r.kind === 'applied' ? out('closed', `answered late via ${late.tool}`, late.id) : out('unchanged', `close refused: ${r.kind}`);
  }

  // Ordering arm: a turn that answered and THEN delegated. At finalize (and at boot, for a process killed
  // before it) a `done` row with an unresolved join is handed back: `done -> open` by the engine pointing at
  // the receipt it undoes, then the ordinary hold. The `done` event stays in the history.
  if (ask.state === 'done' && (ctx.at === 'finalize' || ctx.at === 'boot') && joinOutstanding(ask)) {
    // `evidenceRef` names the undone delivery for the audit; `clearResultDelivery` drops the column, which
    // is current state: a handed-back row is settled on nothing (`owedSendObligations` needs it NULL).
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined,
      clearResultDelivery: true,
      reason: 'handed back: this turn closed the ask and THEN delegated the work under it — '
        + 'the delivery it closed on answered nothing, and the delegated pieces are still out',
    });
    if (undo.kind === 'applied') {
      logger.warn('ask handed back at the turn boundary: it was closed and then delegated under', {
        agentId: ask.agent_id, workId, remaining: ask.remaining_children,
        compilePending: ask.compile_pending, turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      const held = settleAsk(workId, ctx);
      return held.verdict === 'unchanged'
        ? out('reopened', 'handed back after a close-then-delegate turn')
        : held;
    }
  }

  // A turn that parked its job did not answer the request it closed on the way: the ask goes back owed and is held
  // on its job. No rung is spent, because the engine, not the model, ended the turn.
  if (ask.state === 'done' && ctx.at === 'finalize' && ctx.parkedTask && linkedTaskOf(ask.agent_id, ask.root_id)) {
    const reason = `handed back: turn ${ctx.turnNumber ?? '?'} parked the job this request waits on, `
      + 'so what it delivered on the way is not the answer; the ask stays owed and closes when the job delivers';
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined, clearResultDelivery: true, reason,
    });
    if (undo.kind === 'applied') {
      logger.info('ask handed back: closed by a turn that parked its job', { agentId: ask.agent_id, workId, turnNumber: ctx.turnNumber }, ask.agent_id);
      return settleAsk(workId, ctx);
    }
  }

  // Receipt-truth arm: a row closed mid-turn on a bubble the finished turn does not call its answer is
  // re-adjudicated once: the receipt moves to the real answer, or the ask goes back owed with the cause.
  if (ask.state === 'done' && (ctx.at === 'finalize' || ctx.at === 'boot')
      && receiptIsASupersededBubble(ask, ctx.turnNumber)) {
    const answer = qualifyingDelivery(ask, ctx.turnNumber);
    if (answer) {
      getDb().prepare('UPDATE work SET result_delivery_id = ?, updated_at = ? WHERE id = ?')
        .run(answer.id, Date.now(), workId);
      appendWorkEvent(workId, 'audit', actorId, {
        marker: 'ct0_receipt_repointed',
        from_delivery_id: ask.result_delivery_id, to_delivery_id: answer.id, tool: answer.tool,
        turn_number: ctx.turnNumber,
        reason: 'the ask was closed mid-turn on the model\'s opening start-ack. The same turn '
          + 'went on to deliver a real answer, and the receipt now points at that instead — '
          + 'a start-ack is not an answer, and the ticket must name what answered.',
      });
      logger.info('ask receipt re-pointed: it named the start-ack, not the answer', {
        agentId: ask.agent_id, workId, from: ask.result_delivery_id, to: answer.id,
        turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      return out('unchanged', `receipt re-pointed to the answer this turn delivered (${answer.tool})`, answer.id);
    }
    const undo = transition(workId, {
      to: 'open', by: 'engine', actorId: 'ask-settlement', expectedState: 'done',
      evidenceRef: ask.result_delivery_id ?? undefined,
      clearResultDelivery: true,
      reason: 'handed back: this ask was closed on the model\'s opening start-ack and the turn '
        + 'then finished without delivering an answer — nobody was answered, so the person is '
        + 'still waiting and the ask is owed again rather than left looking finished',
    });
    if (undo.kind === 'applied') {
      const handed = handBackAsk(workId, {
        agentId: ask.agent_id, turnNumber: ctx.turnNumber, cause: handBackCauseOf(turnExitReason(ask.agent_id, ctx.turnNumber), ctx),
        retryAt: ctx.retryAt, actorId, reason: 'the turn acked and then finished without answering',
      });
      if (handed.verdict === 'held') return handed;
      logger.warn('ask handed back at the turn boundary: it was closed on a start-ack that nothing followed', {
        agentId: ask.agent_id, workId, receipt: ask.result_delivery_id, turnNumber: ctx.turnNumber,
      }, ask.agent_id);
      const after = settleAsk(workId, ctx);
      return after.verdict === 'unchanged'
        ? out('reopened', 'handed back after a turn that acked and never answered')
        : after;
    }
  }

  if (isTerminal(ask.state)) return out('unchanged', `already ${ask.state}`);

  // Async arm: a background job's result reached the owner after the turn that started it.
  if (ctx.at === 'async') return settleOnAsyncResult(ask, ctx, actorId, out);

  // Join arm, above the hold arm: `compile_pending` is still 1 here (`transition()` clears it on a terminal
  // move), so a hold tested first would hold the very row whose answer just landed.
  if (ctx.at === 'join') return settleOnJoin(ask, ctx, actorId, out);

  // Hold: delegated work is outstanding, so the ask stays owed (`blocked`) until the compiled answer lands.
  if (joinOutstanding(ask)) {
    if (ask.state === 'blocked') return out('held', 'already held on the delegation');
    const reason = 'held: delegated work is still outstanding '
      + `(${ask.remaining_children ?? 0} child(ren) remaining`
      + `${ask.compile_pending === 1 ? ', compile pending' : ''}) — `
      + 'an ask is not answered because a turn spoke about starting it';
    const r = transition(workId, {
      to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason,
    });
    if (r.kind !== 'applied') return out('unchanged', `hold refused: ${r.kind}`);
    logger.info('ask held: delegated work outstanding', {
      agentId: ask.agent_id, workId, remaining: ask.remaining_children, compilePending: ask.compile_pending,
    }, ask.agent_id);
    return out('held', reason);
  }

  const onJob = jobHold(ask, ctx, actorId, out);
  if (onJob) return onJob;

  const evidence = qualifyingDelivery(ask, ctx.turnNumber)
    ?? (ctx.at === 'finalize' ? delegatedRelayEvidence(ask, ctx.turnNumber, [...ENGINE_JOIN_RELAY_TOOLS]) : null);
  if (evidence) {
    const r = transition(workId, {
      to: 'done', by: 'agent', actorId, resultDeliveryId: evidence.id,
      expectedState: ask.state, reason: `delivered via ${evidence.tool}`,
    });
    if (r.kind !== 'applied') return out('unchanged', `close refused: ${r.kind}`, evidence.id);
    if (ctx.rowid != null && ctx.turnNumber != null) {
      recordServingTurnByRowid({ agentId: ask.agent_id, rowid: ctx.rowid, servedByTurn: ctx.turnNumber });
    }
    const opened = linkedTaskOf(ask.agent_id, ask.root_id, { parkOpened: true });   // the agent never heard of it
    if (opened) handInOnDelivery(ask.agent_id, async () => [opened], 'the request this task was opened for was answered', evidence.id);
    return out('closed', `delivered via ${evidence.tool}`, evidence.id);
  }

  // The reply is queued and the sender will try: the ask stays with its turn, neither owed nor served again.
  if (ask.state === 'claimed' && replyInFlight(workId)) return out('held', 'the reply is on its way');
  const undelivered = ask.state === 'claimed' ? undeliveredReply(ask, ctx.turnNumber, ctx.at === 'delivery') : null;
  if (undelivered) {
    const why = `the reply could not be sent (${undelivered.outcome}): ${undelivered.detail ?? 'no reason recorded'}`;
    const r = transition(workId, { to: 'failed', by: 'engine', actorId: 'ask-settlement', expectedState: ask.state, evidenceRef: undelivered.id, reason: why });
    return r.kind === 'applied' ? out('closed', why) : out('unchanged', `fail refused: ${r.kind}`);
  }

  // No turn-bound evidence, but its background jobs' results already reached the owner and nothing is owed.
  if (ctx.at === 'finalize') {
    const late = settleOnAsyncResult(ask, { ...ctx, deliveryId: null }, actorId, out);
    if (late.verdict === 'closed') return late;
  }

  // No evidence. Mid-turn this means nothing yet: re-opening a live claim would race the turn.
  if (ctx.at === 'delivery') return out('unchanged', 'no qualifying delivery yet; the turn is still live');
  // At boot the crash arm (`reconcileOrphanedClaims`) owns the no-evidence case.
  if (ctx.at === 'boot') return out('unchanged', 'no qualifying delivery; the crash arm decides');
  // A request whose background jobs are still out is held, not re-served (a re-serve lets a model start
  // the same work twice). No rung is spent.
  if (mediaJobs(ask.root_id).out > 0) {
    if (ask.state === 'blocked') return out('held', 'already held on its background jobs');
    const why = 'held: the background jobs this request started are still out; their result is the answer';
    const h = transition(workId, { to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason: why });
    return h.kind === 'applied' ? out('held', why) : out('unchanged', `hold refused: ${h.kind}`);
  }
  if (ask.state === 'open') return out('unchanged', 'already open and waiting');
  if (ctx.askedNothing === true && turnEndedInModelSilence(ask.agent_id, ctx.turnNumber)) {
    const why = 'settled: the message asked for nothing (it only declined or acknowledged) and the agent stayed silent';
    const r = transition(workId, { to: 'abandoned', by: 'agent', actorId, expectedState: ask.state, reason: why });
    return r.kind === 'applied' ? out('closed', why) : out('unchanged', `settle refused: ${r.kind}`);
  }
  // The required reply said nothing to the person: held now, the owner told once on the request's own record.
  if (ctx.forcedEmpty) return standDownReServe(ask, ctx, actorId, reServesSpent(workId, 'silence'), out);
  // Who ended the turn decides which count moves and when it is served again (the exit table).
  const exit = turnExitReason(ask.agent_id, ctx.turnNumber);
  const cause = handBackCauseOf(exit, ctx);
  const reason = cause === 'silence'
    ? `re-opened: turn ${ctx.turnNumber ?? '?'} finalized with no delivery that answers this ask, `
      + 'so the person is still waiting and the ask is visible again rather than parked'
    : `re-opened: the engine ended the turn (${ctx.turnNumber ?? '?'}, ${exit}) before it delivered an answer, `
      + 'so the person is still waiting';
  const handed = handBackAsk(workId, { agentId: ask.agent_id, turnNumber: ctx.turnNumber, cause, retryAt: ctx.retryAt, actorId, reason });
  logger.info('ask handed back: its turn finalized without delivering an answer', {
    agentId: ask.agent_id, workId, turnNumber: ctx.turnNumber, from: ask.state, cause, verdict: handed.verdict,
  }, ask.agent_id);
  return handed;
}

// Join arm: the delegated job's own settlement, on the same rule. All children must have settled, the
// delivery must land after the row's `join_complete` event, and it must be an answer at all. The delegating
// turn's own status line is never the compiled report.

/**
 * The turn that delegated, via `claimingTurnOf` (`store.ts`); `null` when never claimed. The compiled answer
 * must come from a later turn, so the delegating turn's own status line never counts. A delivery with no
 * turn qualifies, and so does the engine's relay of this join even when `recordDelivery` stamped the
 * ambient turn.
 */
const delegatingTurn = claimingTurnOf;


/** When the join's countdown reached zero, from the row's own event; `null` when it never did. */
function joinCompletedAt(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'join_complete'`,
  ).get(workId) as { at: number | null } | undefined;
  return r?.at ?? null;
}

/** The compiled answer's receipt, or null. A named delivery is checked by the same predicate. The dashboard copy
 *  of a delegated request's answer, or of a background job's result, still counts here, whatever the channel. */
function compiledDelivery(
  ask: AskRow, completedAtMs: number, named: string | null | undefined, afterTurn: number | null,
): { id: string; tool: string } | null {
  const db = getDb();
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  const relayTools = [...ENGINE_JOIN_RELAY_TOOLS];
  const floorSec = Math.floor(completedAtMs / 1000);
  // The delegating turn's own bubbles are not the compiled answer: a later turn, no turn, or the engine's
  // relay of THIS join qualifies. Keyed to the relay's `joinId`, not the tool alone, or one join's relay
  // would settle another ask in the same conversation.
  const relaySql = relayTools.map((_, i) => `@r${i}`).join(', ');
  const laterTurn = afterTurn == null ? ''
    : `AND (d.turn_number IS NULL OR d.turn_number > @afterTurn
            OR (d.tool IN (${relaySql}) AND json_extract(d.payload_json, '$.joinId') = @joinId))`;
  const bind = (extra: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = {
      agentId: ask.agent_id, floorSec, joinId: ask.id, ...extra,
    };
    excluded.forEach((t, i) => { o[`x${i}`] = t; });
    relayTools.forEach((t, i) => { o[`r${i}`] = t; });
    if (afterTurn != null) o.afterTurn = afterTurn;
    return o;
  };
  const excludedSql = excluded.map((_, i) => `@x${i}`).join(', ');
  if (named) {
    return (db.prepare(
      `SELECT d.id AS id, d.tool AS tool FROM deliveries d
        WHERE d.id = @named AND d.agent_id = @agentId AND d.outcome = 'delivered'
          AND d.tool NOT IN (${excludedSql})
          AND ${NOT_A_TOOL_CHIP}
          AND ${NOT_A_SUPERSEDED_BUBBLE}
          AND unixepoch(d.created_at) >= @floorSec
          ${laterTurn}`,
    ).get(bind({ named })) as { id: string; tool: string } | undefined) ?? null;
  }
  if (ask.conversation_id == null) return null;
  return (db.prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = @agentId AND d.conversation_id = @conv AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excludedSql})
        AND ${NOT_A_TOOL_CHIP}
        AND ${NOT_A_SUPERSEDED_BUBBLE}
        AND unixepoch(d.created_at) >= @floorSec
        ${laterTurn}
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(bind({ conv: ask.conversation_id })) as
    { id: string; tool: string } | undefined) ?? null;
}

/** Has the engine already relayed this join's answer, or queued the relay? A relay of this join after its
 *  `join_complete` means the ladder's last rung must not relay again, even if the settlement after the
 *  first relay was refused. Reads the delivery ledger, never a flag. */
export function priorEngineJoinRelay(workId: string): { id: string; tool: string } | null {
  const ask = readAsk(workId);
  if (!ask) return null;
  const completedAt = joinCompletedAt(workId);
  if (completedAt == null) return null;
  const tools = [...ENGINE_JOIN_RELAY_TOOLS];
  const bind: Record<string, unknown> = {
    agentId: ask.agent_id,
    floorSec: Math.floor(completedAt / 1000),
    joinId: workId,
  };
  tools.forEach((t, i) => { bind[`t${i}`] = t; });
  return (getDb().prepare(
    `SELECT d.id AS id, d.tool AS tool FROM deliveries d
      WHERE d.agent_id = @agentId AND d.outcome IN ('delivered', 'pending')
        AND d.tool IN (${tools.map((_, i) => `@t${i}`).join(', ')})
        AND json_extract(d.payload_json, '$.joinId') = @joinId
        AND unixepoch(d.created_at) >= @floorSec
      ORDER BY d.created_at ASC, d.rowid ASC LIMIT 1`,
  ).get(bind) as { id: string; tool: string } | undefined) ?? null;
}

function settleOnJoin(
  ask: AskRow,
  ctx: SettlementContext,
  actorId: string,
  out: (v: AskSettlementVerdict, detail: string, deliveryId?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  const basis = ctx.basis ?? 'compiled';
  // One completed-countdown rule, asked as "is this the late-answer arm?": testing each other basis
  // separately would route a new basis down the late-answer arm, which is a different rule.
  const lateAnswer = basis === 'late-answer';
  let boundaryMs: number;
  if (!lateAnswer) {
    if ((ask.remaining_children ?? -1) !== 0) {
      return out('unchanged',
        `the children have not all settled (${ask.remaining_children ?? 'no join'} outstanding)`);
    }
    const completedAt = joinCompletedAt(ask.id);
    if (completedAt == null) return out('unchanged', 'the join never recorded a completion');
    boundaryMs = completedAt;
  } else {
    boundaryMs = ask.opened_at;
  }
  // The late-answer arm has no delegating-turn constraint: its answer arrived out of band.
  const evidence = compiledDelivery(
    ask, boundaryMs, ctx.deliveryId, lateAnswer ? null : delegatingTurn(ask.id),
  );
  if (!evidence) {
    return out('unchanged', lateAnswer
      ? 'the late answer produced no delivery that can be pointed at'
      : 'the compiled answer has not landed for the owner yet');
  }
  const reason = ctx.reason ?? 'the compiled answer reached the owner';
  const r = transition(ask.id, {
    to: 'done', by: 'engine', actorId, reason,
    evidenceRef: evidence.id, resultDeliveryId: evidence.id,
  });
  if (r.kind !== 'applied') return out('unchanged', `join close refused: ${r.kind}`, evidence.id);
  // `compile_resolved` is the history of the resolution; `transition()`'s terminal arm clears the flag.
  appendWorkEvent(ask.id, 'compile_resolved', actorId, {
    reason, basis, delivery_id: evidence.id, tool: evidence.tool, boundary_at: boundaryMs,
  });
  // Record on the delivery which ask it answered: a compiled answer on a bare wake carries no
  // `root_kind`/`root_id`. Only ever fills a blank; an attributed delivery is never re-pointed.
  try {
    getDb().prepare(
      `UPDATE deliveries SET root_kind = 'ask', root_id = ?
        WHERE id = ? AND COALESCE(root_kind, '') = '' AND COALESCE(root_id, '') = ''`,
    ).run(ask.id, evidence.id);
  } catch (err) {
    logger.warn('join settled: the compiled delivery could not be stamped with the ask it answered', {
      workId: ask.id, deliveryId: evidence.id, error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('join settled: the compiled answer reached the owner', {
    agentId: ask.agent_id, workId: ask.id, deliveryId: evidence.id, tool: evidence.tool,
  }, ask.agent_id);
  return out('closed', reason, evidence.id);
}

// Async arm: a background job's result (image, music, speech, video) is posted by the worker after the turn
// that started it, with no turn. The ask settles on a DELIVERED result once nothing is owed: no job out, no
// delegated work, no open linked tracker task, no turn serving it; whichever ends last
// re-asks. A request whose jobs were all cancelled and delivered nothing is the owner's call-off: abandoned.

function mediaJobs(askRootId: string): { all: number; out: number; cancelled: number } {
  const db = getDb();
  const t = { all: 0, out: 0, cancelled: 0 };
  for (const table of ['generation_jobs', 'video_jobs']) {
    const r = db.prepare(
      `SELECT COUNT(*) AS n, SUM(status NOT IN (${TERMINAL_JOB_STATUS_SQL})) AS o, SUM(status = 'cancelled') AS c FROM ${table} WHERE source_message_id = ?`,
    ).get(askRootId) as { n: number; o: number | null; c: number | null };
    t.all += r.n; t.out += r.o ?? 0; t.cancelled += r.c ?? 0;
  }
  return t;
}

/** Job hold: while the request's task (linked, or parked by this turn for it) runs, a progress text does not close it:
 *  held at send time while its turn is live; at the end held when parked, or by a job turn not ended on its answer. */
function jobHold(ask: AskRow, ctx: SettlementContext, actorId: string, out: (v: AskSettlementVerdict, d: string) => AskSettlementOutcome): AskSettlementOutcome | null {
  if (ctx.at !== 'delivery' && ctx.at !== 'finalize') return null;
  const parked = ctx.parkedTask && ask.claimed_by_turn === ctx.turnNumber && taskNow(ctx.parkedTask).open ? ctx.parkedTask : null;
  const task = linkedTaskOf(ask.agent_id, ask.root_id) ?? parked;
  if (!task) return null;
  if (ctx.at === 'delivery') return turnContext(ask.agent_id)?.turnNumber === ask.claimed_by_turn ? out('held', 'its job is still running') : null;
  const jobTurnEnded = ctx.jobTurn === true
    && (handBackCauseOf(turnExitReason(ask.agent_id, ctx.turnNumber), ctx) !== 'silence' || !qualifyingDelivery(ask, ctx.turnNumber));
  if (!taskNow(task).parked && !jobTurnEnded) return null;
  if (ask.state === 'blocked') return out('held', 'already held on its job');
  const r = transition(ask.id, { to: 'blocked', by: 'agent', actorId, expectedState: ask.state, reason: JOB_HOLD_REASON, evidenceRef: task });
  return r.kind === 'applied' ? out('held', 'held on its job') : out('unchanged', `job hold refused: ${r.kind}`);
}

/** After commit the engine hands in the tasks `tasks` names, finished on delivery `deliveryId`; a refusal is logged. */
function handInOnDelivery(agentId: string, tasks: () => Promise<string[]>, because: string, deliveryId: string): void {
  afterCommit(() => void Promise.all([tasks(), import('./done/hand-in.js')]).then(([ids, { engineHandIn }]) => {
    for (const id of ids) {
      const r = engineHandIn(id, because, { outcome: 'finished', items: [{ kind: 'delivery', ref: deliveryId }] });
      if (r.kind === 'refused') logger.warn('the engine could not hand in a task', { task: id, why: r.text.slice(0, 200) }, agentId);
    }
  }).catch((err: unknown) => logger.warn('a delivered job\'s tasks were not handed in', { deliveryId, error: String(err) }, agentId)));
}

/** A tracker task `t` linked to the request of ask `a` by its message, not ended and not handed in. */
export const LINKED_OPEN_TASK = (a: string): string =>
  `t.kind = 'task' AND t.agent_id = ${a}.agent_id AND t.source_message_id = ${a}.root_id`
  + ` AND t.state NOT IN ('done', 'failed', 'abandoned') AND ${handedInExpr('t')} = 0`;

/** The open task linked to `agentId`'s request `messageId`, or null; with `ownerHeldEnds` a task the owner holds
 *  counts as ended; with `parkOpened` only a task a park opened. */
export function linkedTaskOf(agentId: string, messageId: string | null, opts: { ownerHeldEnds?: true; parkOpened?: true } = {}): string | null {
  if (!messageId) return null;
  const notHeld = (opts.ownerHeldEnds ? ` AND NOT ${heldByOwnerSql('t')}` : '')
    + (opts.parkOpened ? ` AND t.root_kind = '${ENGINE_SCAFFOLD_ROOT_KIND}' AND t.title = '${PARKED_JOB_TITLE}'` : '');
  return (getDb().prepare(`SELECT t.id AS id FROM (SELECT ? AS agent_id, ? AS root_id) a JOIN work t ON ${LINKED_OPEN_TASK('a')}${notHeld} LIMIT 1`)
    .get(agentId, messageId) as { id: string } | undefined)?.id ?? null;
}

function stillOwed(ask: AskRow, ignoreTurn: number | null): string | null {
  if (linkedTaskOf(ask.agent_id, ask.root_id)) return 'a tracker task linked to this request is still open (its holder has not handed it in)';
  const bag = turnContext(ask.agent_id);
  if (bag?.root?.kind === 'ask' && bag.root.sourceMessageId === ask.root_id && bag.turnNumber !== ignoreTurn) {
    return 'a turn serving this request is running';
  }
  return null;
}

function settleOnAsyncResult(
  ask: AskRow, ctx: SettlementContext, actorId: string,
  out: (v: AskSettlementVerdict, detail: string, deliveryId?: string | null) => AskSettlementOutcome,
): AskSettlementOutcome {
  if (joinOutstanding(ask)) return out('unchanged', 'delegated work is still outstanding');
  const jobs = mediaJobs(ask.root_id);
  // Release: a request held on its job, once no task linked to it still works (ended, or held by the owner), closes
  // on a real answer since the hold, else goes back owed so the agent tells the person where it stands.
  const heldAt = ask.state === 'blocked' && jobs.out === 0 ? jobHeldAt(ask.id) : null;
  if (heldAt && !linkedTaskOf(ask.agent_id, ask.root_id, { ownerHeldEnds: true })) {
    const late = realAnswerInConversationSince(ask.agent_id, ask.conversation_id, heldAt.at);
    // The owner called the job off: so is the request (the async arm's own rule).
    const calledOff = !late && !!getDb().prepare(`SELECT 1 FROM work t JOIN work_events e ON e.work_id = t.id AND e.kind = 'transition'
      WHERE t.kind = 'task' AND t.agent_id = ? AND t.source_message_id = ? AND t.state = 'abandoned'
        AND json_extract(e.payload, '$.to') = 'abandoned' AND json_extract(e.payload, '$.by') = 'owner' LIMIT 1`).get(ask.agent_id, ask.root_id);
    const r = late
      ? transition(ask.id, { to: 'done', by: 'agent', actorId, resultDeliveryId: late.id, expectedState: 'blocked', reason: `its job ended; answered via ${late.tool}` })
      : calledOff ? transition(ask.id, { to: 'abandoned', by: 'owner', actorId: 'owner', expectedState: 'blocked', reason: 'the owner called off the job this request waited on' })
      : transition(ask.id, { to: 'open', by: 'agent', actorId: 'engine', expectedState: 'blocked', reason: 'its job ended; the person is told where it stands' });
    if (r.kind !== 'applied') return out('unchanged', `release refused: ${r.kind}`);
    return late ? out('closed', `its job ended; answered via ${late.tool}`, late.id) : calledOff ? out('closed', 'called off by the owner') : out('reopened', 'its job ended');
  }
  if (jobs.all === 0) return out('unchanged', 'no background job was started for this request');
  if (jobs.out > 0) return out('unchanged', `${jobs.out} background job(s) for this request are still out`);
  // The result the owner was given: the one named, else the latest bubble labelled with this request.
  const named = ctx.deliveryId ?? (getDb().prepare(
    `SELECT d.id AS id FROM deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.agent_id = ? AND d.outcome = 'delivered' AND m.root_kind = 'ask' AND m.root_id = ? AND m.subject_kind = 'delivered'
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`,
  ).get(ask.agent_id, ask.root_id) as { id: string } | undefined)?.id ?? null;
  if (!named) {
    if (jobs.cancelled === 0) return out('unchanged', 'no result has reached the owner');
    const r = transition(ask.id, {
      to: 'abandoned', by: 'owner', actorId: 'owner', expectedState: ask.state,
      reason: 'the owner cancelled the background work this request waited on, and nothing was delivered',
    });
    return r.kind === 'applied' ? out('closed', 'cancelled by the owner') : out('unchanged', `cancel close refused: ${r.kind}`);
  }
  const owed = stillOwed(ask, ctx.turnNumber);
  if (owed) return out('unchanged', owed);
  const evidence = compiledDelivery(ask, ask.opened_at, named, null);
  if (!evidence) return out('unchanged', 'the result has no delivery that can be pointed at');
  const reason = ctx.reason ?? 'the background work it waited on finished and its result reached the owner';
  const r = transition(ask.id, {
    to: 'done', by: 'engine', actorId, reason, evidenceRef: evidence.id, resultDeliveryId: evidence.id,
  });
  if (r.kind !== 'applied') return out('unchanged', `async close refused: ${r.kind}`, evidence.id);
  logger.info('ask settled: the background work it waited on reached the owner', {
    agentId: ask.agent_id, workId: ask.id, deliveryId: evidence.id, tool: evidence.tool,
  }, ask.agent_id);
  return out('closed', reason, evidence.id);
}

function reaskAsync(agentId: string, askMessageId: string | null | undefined, deliveryId: string | null): AskSettlementOutcome | null {
  if (!askMessageId) return null;
  try {
    return settleAsk(askIdForMessage(askMessageId), { agentId, turnNumber: null, at: 'async', deliveryId, actorId: 'async-result' });
  } catch (err) {
    logger.warn('async: could not re-ask the settlement of a request (nothing it delivered is affected)', {
      agentId, askMessageId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

export function settleAskOnAsyncResult(
  p: { agentId: string; askMessageId: string | null | undefined; resultMessageId: string },
): AskSettlementOutcome | null {
  const delivery = getDb().prepare(
    `SELECT id FROM deliveries WHERE agent_id = ? AND message_id = ? AND outcome = 'delivered' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(p.agentId, p.resultMessageId) as { id: string } | undefined;
  return delivery ? reaskAsync(p.agentId, p.askMessageId, delivery.id) : null;
}

/** A job ended without a bubble (cancelled by a stop or the owner): re-ask the request it belonged to. */
export function settleAskOnJobEnded(agentId: string, jobId: string): AskSettlementOutcome | null {
  const db = getDb();
  for (const table of ['generation_jobs', 'video_jobs']) {
    const r = db.prepare(`SELECT source_message_id AS m FROM ${table} WHERE id = ?`).get(jobId) as { m: string | null } | undefined;
    if (r) return reaskAsync(agentId, r.m, null);
  }
  return null;
}

export function settleAskOnTaskEnded(agentId: string, askMessageId: string | null | undefined): void {
  announceAgentLiveWork(agentId);   // an ended task is no longer a parked job Stop would end
  reaskAsync(agentId, askMessageId, null);
}
onTaskEnded(settleAskOnTaskEnded);

/** The join relay: scope only. Without `deliveryId` the authority finds the compiled answer itself. */
export function settleAskOnJoin(
  parentWorkId: string,
  p: {
    agentId?: string; deliveryId?: string | null; reason: string; actorId?: string | null;
    basis?: 'compiled' | 'engine-relay' | 'late-answer';
  },
): AskSettlementOutcome {
  // `agentId` is scope the join arm does not need; it is optional and the actor defaults to the relay.
  return settleAsk(parentWorkId, {
    agentId: p.agentId ?? 'a2a-join', turnNumber: null, at: 'join',
    deliveryId: p.deliveryId ?? null, reason: p.reason, basis: p.basis,
    actorId: p.actorId ?? 'a2a-join',
  });
}

export interface DeliveryCloseInput {
  agentId: string;
  turnNumber: number | null;
  deliveryId: string;
  conversationId: string | null;
  tool: string;
  outcome: string;
  /** A relay's request: its verdict settles that request, not the asks of a turn. */
  joinId?: string | null;
}

/** A quick ask is done when something was delivered for it, at send time (closing at finalize would make
 *  every quick answer wait for the turn boundary). The arguments narrow scope; `settleAsk` re-reads. */
export function settleAsksForDelivery(p: DeliveryCloseInput): number {
  if (p.joinId) {
    if (p.outcome === 'delivered') onRelayDelivered(p.joinId, p);
    else if (p.outcome === 'failed') onRelayEnded(p.joinId, p);
    return 0;
  }
  // A reply that failed for good settles its asks too: they end failed rather than wait for ever.
  if (p.outcome !== 'delivered' && p.outcome !== 'failed') return 0;
  if (p.turnNumber == null || p.conversationId == null) return 0;
  if (NON_ANSWERING_DELIVERY_TOOLS.has(p.tool)) return 0;
  let closed = 0;
  for (const id of asksAnsweredBy(p.agentId, p.turnNumber, p.conversationId)) {
    const s = settleAsk(id, { agentId: p.agentId, turnNumber: p.turnNumber, at: 'delivery' });
    if (s.verdict === 'closed') closed++;
  }
  return closed;
}

/** A relay went: its request settles on it, and the cards the agent opened for that job are handed in. */
function onRelayDelivered(joinId: string, p: DeliveryCloseInput): void {
  const settled = settleAskOnJoin(joinId, {
    agentId: p.agentId, deliveryId: p.deliveryId, reason: 'the engine relayed the delegated answer',
    basis: p.tool === 'a2a-join-late' ? 'late-answer' : 'engine-relay',
  });
  if (settled.verdict !== 'closed') return;
  handInOnDelivery(p.agentId, async () => (await import('./join-drive.js')).scaffoldCardsOfRelay(joinId, p.agentId).map((c) => c.id),
    `the engine relayed the compiled result of the job this card was opened for to the owner (delivery ${p.deliveryId.slice(0, 8)})`, p.deliveryId);
}

/** A relay that never went ends its request failed, with the row's reason; a failure notice ends nothing. */
function onRelayEnded(joinId: string, p: DeliveryCloseInput): void {
  const ask = readAsk(joinId);
  if (!ask || isTerminal(ask.state) || p.tool === 'a2a-join-failed') return;
  const why = (getDb().prepare('SELECT detail FROM deliveries WHERE id = ?').get(p.deliveryId) as { detail: string | null }).detail;
  failJoinClosed(joinId, { reason: `the helper's answer could not be sent${why ? ` (${why})` : ''}; it is in the chat`, expectedState: ask.state });
}

/** The requests this turn claimed that it still owes an answer: nothing delegated, linked, out as a job or queued. */
export function owedAtTurnEnd(agentId: string, turnNumber: number): string[] {
  const rows = getDb().prepare(
    `SELECT w.id AS id, w.root_id AS root_id FROM work w
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'claimed' AND w.claimed_by_turn = ?
        AND COALESCE(w.remaining_children, 0) = 0 AND w.compile_pending = 0 AND NOT ${REPLY_IN_FLIGHT}
        AND NOT EXISTS (SELECT 1 FROM work t WHERE ${LINKED_OPEN_TASK('w')})`,
  ).all(agentId, turnNumber) as Array<{ id: string; root_id: string }>;
  return rows.filter((r) => mediaJobs(r.root_id).out === 0).map((r) => r.id);
}

/** The requests a turn's reply in a conversation answers: the asks that turn holds claimed there. */
export function asksAnsweredBy(agentId: string, turnNumber: number, conversationId: string): string[] {
  return (getDb().prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed'
        AND claimed_by_turn = ? AND conversation_id = ?`,
  ).all(agentId, turnNumber, conversationId) as Array<{ id: string }>).map((r) => r.id);
}


/** An ask in the assembled-context set and the message row to stamp when it settles, from
 *  `assembledContextAsks` (`agent/v2/counterparty.ts`), which only reads. */
export interface AssembledAsk { workId: string; rowid: number }

export interface FinalizeSettlementInput extends TurnEnd {
  agentId: string;
  turnNumber: number;
  /** Every ask that entered this turn's context; rows arriving after the final assembly are absent. */
  assembled?: AssembledAsk[];
  /** The trigger ask whose message asked for nothing (`inboundAsksNothing`). */
  askedNothing?: string | null;
}

export interface FinalizeSettlementResult { closed: number; held: number; reopened: number }

/** The turn is over: every ask it claimed or assembled gets its verdict. No ask stays `claimed` by a finalized
 *  turn unless its reply is on its way (`work/__tests__/ask-done-census.test.ts`). The claimed set is scoped by
 *  turn, not conversation: an ask picked up and answered elsewhere is still this turn's to dispose of. */
export function settleAsksAtTurnFinalize(p: FinalizeSettlementInput): FinalizeSettlementResult {
  const result: FinalizeSettlementResult = { closed: 0, held: 0, reopened: 0 };
  const db = getDb();
  const claimed = db.prepare(
    `SELECT id FROM work
      WHERE agent_id = ? AND kind = 'ask' AND state = 'claimed' AND claimed_by_turn = ?`,
  ).all(p.agentId, p.turnNumber) as Array<{ id: string }>;
  // Third scope: an ask THIS TURN CLOSED (`claimed_by_turn` is cleared by the close, so the turn is found
  // through the receipt). The arms ask their own questions; the scope only says which rows the turn owns.
  const closedByThisTurn = db.prepare(
    `SELECT w.id AS id FROM work w
      WHERE w.agent_id = ? AND w.kind = 'ask' AND w.state = 'done'
        AND w.result_delivery_id IN (
          -- the outcome filter is redundant here (the receipt can only come from a delivered row);
          -- every reader of this table carries it, so an owner's close receipt is never read as a send.
          SELECT d.id FROM deliveries d
           WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered')`,
  ).all(p.agentId, p.agentId, p.turnNumber) as Array<{ id: string }>;

  const seen = new Set<string>();
  const tally = (v: AskSettlementVerdict): void => {
    if (v === 'closed') result.closed++;
    else if (v === 'held') result.held++;
    else if (v === 'reopened') result.reopened++;
  };
  for (const r of [...claimed, ...closedByThisTurn]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    tally(settleAsk(r.id, { ...p, at: 'finalize', askedNothing: r.id === p.askedNothing }).verdict);
  }
  for (const a of p.assembled ?? []) {
    if (seen.has(a.workId)) continue;
    seen.add(a.workId);
    tally(settleAsk(a.workId, { ...p, at: 'finalize', rowid: a.rowid, askedNothing: a.workId === p.askedNothing }).verdict);
  }
  if (result.closed > 0 || result.held > 0 || result.reopened > 0) {
    logger.info('turn finalize: owner asks adjudicated', {
      agentId: p.agentId, turnNumber: p.turnNumber, ...result, considered: seen.size,
    }, p.agentId);
  }
  return result;
}
