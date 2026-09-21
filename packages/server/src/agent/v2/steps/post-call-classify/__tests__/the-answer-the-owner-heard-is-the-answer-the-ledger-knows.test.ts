// ════════════════════════════════════════════════════════════════════════════════════════
// ANSWER-ANYWAY — THE OWNER HEARD IT, SO THE LEDGER MUST FIND OUT.
//
// THE INCIDENT, from the engine's own rows (release ritual v3.1.26 round 3, seed
// `eceef8a09723`, scenario `gen-web-research-with-sourcing-eceef8a09723-5`, run `bmub8ip5nhy`,
// agent turn 5649, ask `695067c2`):
//
//   12:45:10  "Research the current state of e-ink tablets: compare at least 2 options…"
//   12:45:40  the start-ack threshold passes with nothing heard   -> steer requested
//   12:46:23  "start-ack steer: model spoke its start line mid-work; delivered as the visible
//              ack (streamed bubble promoted in place)"
//              preview: "Fresh sources pulled just now (Sep 21, 2026). US prices, as …"
//              — four tablets, three dimensions, ten web calls behind it: THE ANSWER
//   12:46:26  "agent ended turn silently via [no-reply] sentinel"  — correct from its seat
//   12:46:28 / 12:46:30 / 12:46:33   ask re-opened, serves 1-3, each into an agent that had
//                                    already answered
//   12:46:36  ERROR "ask re-serve STOOD DOWN" (serves 4, bound 4); the ask ends `blocked`
//
// ── WHAT THE FIX IS, AND WHAT IT DELIBERATELY IS NOT ──
// The promotion silences BOTH arms of the `[no-reply]` sentinel at once: the REG-3 override
// has nothing left to promote (the promotion consumed `deferredUserReplyWithTools`) and the
// ghosted-work-ask floor stood down on `!deferredDeliveredByAck`. So the turn simply ended,
// and the ledger — keyed on `turns.answer_message_id`, which knows nothing of the ack lane —
// recorded silence.
//
// THE ENGINE DOES NOT DECIDE WHETHER THOSE WORDS WERE AN ANSWER. Ruling 10(a)/OR2: it
// detects, it steers, it verifies through delivery records, and it never adjudicates content
// by heuristic where the model can be made to speak. Ruling 10(d), the owner's words:
// *"Priority one out of literally anything is 'the user asks the agent to do something and it
// does it.' Period."* — so an ambiguous "was this answered?" resolves toward ANSWERING AGAIN,
// never toward a quiet close. The floor is therefore UN-BLINDED and its steer gains SIGHT: the
// model is handed its own promoted line back, told the ask ledger still shows the question
// open, and asked to settle it either way. Whichever it does lands through the ONE door — the
// ordinary persist seam sets `turns.answer_message_id` — so the ask settles on what the model
// actually said, and a status line alone can never become the answer.
//
// ── HOW THESE TESTS DRIVE IT ──
// On a REAL in-memory database, one step at a time in the order the loop runs them, with the
// two production doors simulated in the one row each of them writes: `deliverEngineUserAck`
// persists the bubble and broadcasts it, and the broadcast spy writes the dashboard
// `deliveries` row exactly as `agent/v2/outbound.ts:recordDashboardDelivery` does. Then the
// turn record is written off whatever the truthful-answer key was given, and the real
// settlement authority — UNCHANGED by this task — is asked for its verdict.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolCall } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-answer-anyway-test', 'dojo.db'),
  };
});

/** THE DASHBOARD DOOR, in the one row it writes. `broadcast()` calls
 *  `recordDashboardDelivery` for every persisted assistant `chat:message`
 *  (`gateway/ws.ts:228-242`), which is how the promoted bubble AND the model's own reply
 *  both already reach the delivery ledger. */
const broadcastSpy = vi.fn((event: { type?: string; message?: { id?: string; role?: string } }) => {
  if (event?.type !== 'chat:message' || event.message?.role !== 'assistant') return;
  const id = event.message.id;
  if (!id || !mockDb.current) return;
  const persisted = mockDb.current.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
  if (!persisted) return;   // an emission with no row is not a delivery (the door's own clause)
  mockDb.current.prepare(
    `INSERT OR IGNORE INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                                       message_id, outcome, created_at)
     VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
  ).run(`d-${id}`, AGENT, TURN, CONV, id);
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [never])) }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage, insertMessageIfAbsent, START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../../../work/store.js';
import { settleAsk, settleAsksAtTurnFinalize, MAX_ASK_RE_SERVES } from '../../../../../work/ask-settlement.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { runNoReply } from '../no-reply.js';
import { runPersistAssistant } from '../persist-assistant.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import type { StepOutcome } from '../../step-outcome.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const TURN = 5649;

/** The preview the ritual recorded, at the length the model actually front-loaded. */
const THE_ANSWER =
  'Fresh sources pulled just now (Sep 21, 2026). US prices, as quoted by the reviews I read '
  + 'today: reMarkable Paper Pro $629 (11.8" Canvas Color, ~12ms pen latency), Onyx Boox Note '
  + 'Air4 C $499, Supernote A5 X2 $459, Kindle Scribe $399. Tradeoff: reMarkable is a closed '
  + 'system — no app store, browser or notifications.';

/** The matched control: the same door, the same turn shape, a start line instead. */
const THE_STATUS_LINE = 'On it — pulling sources now';

/** What the model says when the un-blinded steer reaches it and the promotion HAD the answer. */
const THE_CONFIRMATION = 'Yes — that comparison above is the answer: four tablets, priced and sourced today.';

/**
 * THE SENTENCE THE GHOSTED-ASK FLOOR HAS ALWAYS SENT, verbatim. Test (c) asserts the
 * genuine-silence steer is still exactly this and not one byte more, which is what makes the
 * sight clause provably additive rather than a rewrite of the existing floor.
 */
const THE_HISTORICAL_STEER =
  '[Engine hint: you ended with [no-reply], but this message is a direct request from the user. '
  + 'A direct ask never ends in silence. If this exact work was already delivered (check the RECENTLY ANSWERED engine record and your tracker), '
  + 'reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if the user asked for one.]';

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, kind: 'user', convKey: 'dashboard:owner', conversationId: CONV,
  root: { kind: 'ask', id: 'm-1', conversationId: CONV }, servedWork: undefined,
  turnNumber: TURN,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false, startAckPromotedRowId: null,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  inboundClassifiedAsWork: true,
  ...over,
});

const modelResult = (over: Partial<{ content: string; toolCalls: ToolCall[] }> = {}): PostCallClassifyContext['result'] => ({
  content: THE_ANSWER,
  toolCalls: [{ id: 'tc1', name: 'work_update', input: { action: 'status' } }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

/** `deliverEngineUserAck` (`steps/preflight/turn-closures.ts:315`), in the two acts that
 *  matter here: it persists the bubble under the id it was handed, then broadcasts it — and
 *  the broadcast is what puts it on the delivery ledger. */
const deliverEngineUserAck = vi.fn(
  async (text: string, originIntent: string | null, reuseId: string | null, displayKind: string | null) => {
    const id = reuseId ?? 'minted-by-the-closure';
    insertMessageIfAbsent({
      id, agentId: AGENT, role: 'assistant', content: text, turnNumber: TURN,
      originIntent, conversationId: CONV,
      ...(displayKind ? { displayKind: displayKind as 'agent-text' } : {}),
    } as never);
    broadcastSpy({ type: 'chat:message', message: { id, role: 'assistant' } });
  },
);

const noteTerminalAnswer = vi.fn();
const persistAndBroadcastSystemRow = vi.fn();

function ctxFor(turnCtx: Bag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: TURN, db: mockDb.current,
    agent: { id: AGENT, name: 'Kevin' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'dashboard:owner',
    hasUnansweredUser: true,
    triggerRow: { id: 'm-1', content: 'Research the current state of e-ink tablets…' } as never,
    isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'dashboard',
    latestUserSource: null, lastUserMessageContent: 'Research the current state of e-ink tablets…',
    configuredModelId: 'floor', turnStartedAt: new Date().toISOString(), messageId: 'msg-tooluse',
    result: modelResult(), maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer,
    deliverEngineUserAck: deliverEngineUserAck as never,
    persistAndBroadcastSystemRow,
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}): PostCallScratch => ({
  persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor',
  ...over,
});

/** The owner's ask, picked up by this turn — the row the authority adjudicates. */
function claimedAsk(messageId = 'm-1', turn = TURN): string {
  insertMessage({
    id: messageId, agentId: AGENT, role: 'user',
    content: 'Research the current state of e-ink tablets: compare at least 2 options…',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage(messageId), AGENT);
  stampClaimingTurn(askIdForMessage(messageId), turn);
  return askIdForMessage(messageId);
}

/** `teardown/finalize-record.ts`, in the two facts the authority reads: the turn ENDED, and
 *  the truthful-answer key names whatever `noteTerminalAnswer` was last given (or nothing). */
function finalizeTurnRecord(turn = TURN): string | null {
  const key = (noteTerminalAnswer.mock.calls.at(-1)?.[0] as string | undefined) ?? null;
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason,
                                   answered, answer_message_id)
     VALUES (?, ?, datetime('now','-90 seconds'), datetime('now'), ?, ?, ?)`,
  ).run(AGENT, turn, key ? 'answered' : 'no_reply_intended', key ? 1 : 0, key);
  return key;
}

const askRow = (workId: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(workId) as Record<string, unknown>;
const markersFor = (workId: string): string[] =>
  (mockDb.current!.prepare('SELECT payload FROM work_events WHERE work_id = ? ORDER BY id')
    .all(workId) as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { marker?: string }).marker)
    .filter((m): m is string => !!m);
const transitionsFor = (workId: string): Array<{ to: string; reason: string }> =>
  (mockDb.current!.prepare(
    `SELECT payload FROM work_events WHERE work_id = ? AND kind = 'transition' ORDER BY id`,
  ).all(workId) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as { to: string; reason: string });

/** Every `ghosted-ask` steer this turn filed, in order — the queue's own record. */
const ghostedSteers = (s: AgentTurnState): Array<{ floor: string; content: string }> =>
  (s.steerQueue as unknown as { fired: Array<{ floor: string; content: string }> }).fired
    .filter((e) => e.floor === 'ghosted-ask');

let state: AgentTurnState;

/** Model call #1 of turn 5649: the ack is owed and the model speaks WITH a tool call. */
async function promote(text: string, turnCtx: Bag): Promise<void> {
  await runTerminalText(state, ctxFor(turnCtx, { result: modelResult({ content: text }) }), scratchFor());
}

/** Model call #2: the bare sentinel. Returns the step's own outcome, because "did this steer
 *  and go round again?" is part of what these tests assert. */
async function sentinel(turnCtx: Bag): Promise<StepOutcome> {
  const out = await runNoReply(
    state,
    ctxFor(turnCtx, { result: modelResult({ content: '[no-reply]', toolCalls: [] as ToolCall[] }) }),
    scratchFor({ persistedContent: '[no-reply]' }),
  );
  state = out.state;
  return out;
}

/** Model call #3: the model answers the steer with an ordinary tool-less reply — the one door. */
async function ordinaryReply(text: string, turnCtx: Bag, rowId: string): Promise<void> {
  const out = await runPersistAssistant(
    state,
    ctxFor(turnCtx, { messageId: rowId, result: modelResult({ content: text, toolCalls: [] as ToolCall[] }) }),
    scratchFor({ persistedContent: text }),
  );
  state = out.state;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
  broadcastSpy.mockClear(); deliverEngineUserAck.mockClear();
  noteTerminalAnswer.mockClear(); persistAndBroadcastSystemRow.mockClear();
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (a) THE LIVE SHAPE — the answer rode the promotion, and the model is asked to put it on
//     the record rather than the engine deciding it for them
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(a) the shape the ritual caught: the promotion carried the answer', () => {
  it('RED→GREEN: turn 5649 end to end — steered with sight, confirmed by the model, settled; zero blind re-serves, never blocked', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });

    await promote(THE_ANSWER, turnCtx);
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(turnCtx.deferredDeliveredByAck).toBe(true);
    const promotedRowId = turnCtx.startAckPromotedRowId as string;
    expect(promotedRowId).toEqual(expect.any(String));

    // MID-TURN NOTHING CLOSES — T2's rule, untouched by this task.
    expect(settleAsk(workId, { agentId: AGENT, turnNumber: TURN, at: 'delivery' }).verdict)
      .toBe('unchanged');
    expect(askRow(workId).state).toBe('claimed');

    // THE SENTINEL: the floor is no longer blind, so the turn goes round again instead of
    // ending in a silence the ledger would have to guess about.
    const out = await sentinel(turnCtx);
    expect(out.directive).toBe('continue');
    const steers = ghostedSteers(state);
    expect(steers).toHaveLength(1);

    // THE STEER HAS SIGHT — the model's OWN words, read back off the row that carried them,
    // plus the ledger fact. The engine asserts no verdict about what the words were.
    expect(steers[0]!.content).toContain(THE_ANSWER.slice(0, 60));
    expect(steers[0]!.content).toContain('the user HAS heard one line from you this turn');
    expect(steers[0]!.content).toContain('still shows their question OPEN');
    expect(steers[0]!.content).toContain(THE_HISTORICAL_STEER.slice(0, 120));
    // …and nothing has been recorded as the answer by the engine's own hand.
    expect(noteTerminalAnswer).not.toHaveBeenCalled();

    // THE MODEL ANSWERS THE STEER, through the ordinary door.
    await ordinaryReply(THE_CONFIRMATION, turnCtx, 'msg-confirm');
    expect(noteTerminalAnswer).toHaveBeenCalledTimes(1);
    expect(noteTerminalAnswer.mock.calls[0]).toEqual(['msg-confirm', 'a genuine terminal reply']);
    expect(finalizeTurnRecord()).toBe('msg-confirm');

    // THE VERDICT.
    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 1, held: 0, reopened: 0 });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-confirm');
    // …and none of the four symptoms the ritual recorded.
    expect(markersFor(workId)).not.toContain('ct0_ask_re_served');
    expect(transitionsFor(workId).map((t) => t.to)).toEqual(['claimed', 'done']);
  });

  it('the engine never adjudicates the promoted line: it is quoted, never named as the answer', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(THE_ANSWER, turnCtx);
    await sentinel(turnCtx);
    await ordinaryReply(THE_CONFIRMATION, turnCtx, 'msg-confirm');
    finalizeTurnRecord();
    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });

    const key = mockDb.current!.prepare(
      'SELECT answer_message_id FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(AGENT, TURN) as { answer_message_id: string };
    expect(key.answer_message_id).not.toBe(turnCtx.startAckPromotedRowId);
    expect(askRow(workId).result_delivery_id).not.toBe(`d-${turnCtx.startAckPromotedRowId as string}`);
    // The promoted bubble is still exactly what it always was: the model's own words, pushed
    // early, stamped so every reader knows which lane put them there.
    const bubble = mockDb.current!.prepare(
      'SELECT content, origin_intent, display_kind FROM messages WHERE id = ?',
    ).get(turnCtx.startAckPromotedRowId) as { content: string; origin_intent: string; display_kind: string };
    expect(bubble.content).toBe(THE_ANSWER);
    expect(bubble.origin_intent).toBe(START_ACK_ORIGIN_INTENT);
    expect(bubble.display_kind).toBe('agent-text');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (b) THE MATCHED CONTROL — a status line is not an answer, and the model is the one who
//     says so by delivering the real one
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(b) the same door, a status-line-only promotion', () => {
  it('the steer fires on it too, and the ask settles on the REAL answer the model then delivers', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(THE_STATUS_LINE, turnCtx);

    const out = await sentinel(turnCtx);
    expect(out.directive).toBe('continue');
    expect(ghostedSteers(state)).toHaveLength(1);
    expect(ghostedSteers(state)[0]!.content).toContain(THE_STATUS_LINE);
    expect(noteTerminalAnswer).not.toHaveBeenCalled();

    // The model does the other half of what the steer asked for: it delivers the answer.
    await ordinaryReply(THE_ANSWER, turnCtx, 'msg-answer');
    expect(finalizeTurnRecord()).toBe('msg-answer');

    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 1, held: 0, reopened: 0 });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-answer');
  });

  it('the status line ALONE never becomes the turn\'s answer — not the key, not the receipt', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(THE_STATUS_LINE, turnCtx);
    const statusRowId = turnCtx.startAckPromotedRowId as string;
    await sentinel(turnCtx);
    // The model ghosts the steer: nothing more is said, so nothing is recorded as the answer.
    expect(noteTerminalAnswer).not.toHaveBeenCalled();
    expect(finalizeTurnRecord()).toBeNull();

    const key = mockDb.current!.prepare(
      'SELECT answer_message_id FROM turns WHERE agent_id = ? AND turn_number = ?',
    ).get(AGENT, TURN) as { answer_message_id: string | null };
    expect(key.answer_message_id).toBeNull();
    expect(key.answer_message_id).not.toBe(statusRowId);

    // …and the ask goes back to the person, exactly as it does today.
    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 0, held: 0, reopened: 1 });
    expect(askRow(workId).state).toBe('open');
    expect(askRow(workId).result_delivery_id).toBeNull();
    expect(markersFor(workId)).toEqual(['ct0_ask_re_served']);
    expect(transitionsFor(workId).at(-1)!.reason).toContain(`serve 2 of ${MAX_ASK_RE_SERVES + 1}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (c) GENUINE SILENCE — the t82 machinery, whole and byte-identical
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(c) genuine silence: no promotion, and every byte of the old behaviour', () => {
  it('the steer sentence is EXACTLY the one this floor has always sent', async () => {
    claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    // A turn that says nothing to anybody: no text with the tool call, nothing to promote.
    await promote(null as unknown as string, turnCtx);
    expect(deliverEngineUserAck).not.toHaveBeenCalled();
    expect(turnCtx.startAckPromotedRowId).toBeNull();

    await sentinel(turnCtx);
    expect(ghostedSteers(state)).toHaveLength(1);
    expect(ghostedSteers(state)[0]!.content).toBe(THE_HISTORICAL_STEER);
    expect(persistAndBroadcastSystemRow).toHaveBeenCalledWith(THE_HISTORICAL_STEER);
  });

  it('and a model that ghosts it runs the ladder to its bound with the STOOD-DOWN sentence unchanged', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(null as unknown as string, turnCtx);
    await sentinel(turnCtx);
    expect(noteTerminalAnswer).not.toHaveBeenCalled();
    finalizeTurnRecord();

    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN }))
      .toEqual({ closed: 0, held: 0, reopened: 1 });
    for (let i = 1; i <= MAX_ASK_RE_SERVES; i++) {
      const turn = TURN + i;
      claimAsk(workId, AGENT); stampClaimingTurn(workId, turn);
      finalizeTurnRecord(turn);
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    }
    expect(askRow(workId).state).toBe('blocked');
    expect(transitionsFor(workId).at(-1)!.reason).toBe(
      `re-serve stood down after ${MAX_ASK_RE_SERVES + 1} serves: turn ${TURN + MAX_ASK_RE_SERVES} `
      + 'finalized without delivering an answer, as the ones before it did. The ask is NOT '
      + 'answered and is NOT closed — it is held OWED and stays in front of the agent, but the '
      + 'drain will stop serving the same question into the same silence',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (d) THE ORDINARY LANE — untouched
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(d) the normal path: an answer through the ordinary lane settles exactly as it always did', () => {
  it('a tool-less terminal reply closes the ask at send time, with no promotion anywhere near it', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(
      state, ctxFor(turnCtx, { result: modelResult({ content: THE_ANSWER, toolCalls: [] as ToolCall[] }) }), sc,
    );
    expect(sc.persistedContent).toBe(THE_ANSWER);
    expect(deliverEngineUserAck).not.toHaveBeenCalled();
    expect(turnCtx.startAckPromotedRowId).toBeNull();

    await ordinaryReply(THE_ANSWER, turnCtx, 'msg-reply');
    expect(noteTerminalAnswer).toHaveBeenCalledTimes(1);
    expect(settleAsk(workId, { agentId: AGENT, turnNumber: TURN, at: 'delivery' }).verdict).toBe('closed');
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-reply');
  });

  it('CONTROL — acked FIRST and answered after, with no sentinel in between: settles on the ANSWER', async () => {
    const workId = claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(THE_STATUS_LINE, turnCtx);
    const ackRowId = turnCtx.startAckPromotedRowId as string;
    await ordinaryReply(THE_ANSWER, turnCtx, 'msg-reply');
    finalizeTurnRecord();

    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-msg-reply');
    expect(askRow(workId).result_delivery_id).not.toBe(`d-${ackRowId}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE BOUND — un-blinding adds sight, never a loop
// ════════════════════════════════════════════════════════════════════════════════════════

describe('the un-blinded steer is bounded exactly as the ladder already was', () => {
  it('a second sentinel in the same turn files NO second ghosted-ask steer, and stops going round', async () => {
    claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await promote(THE_ANSWER, turnCtx);

    const first = await sentinel(turnCtx);
    expect(first.directive).toBe('continue');
    expect(ghostedSteers(state)).toHaveLength(1);

    // The model ghosts it and emits the sentinel again: the rung is spent, the second rung
    // has no recorded answer to hand back, and silence stands. No new loop.
    const second = await sentinel(turnCtx);
    expect(second.directive).toBe('proceed');
    expect(ghostedSteers(state)).toHaveLength(1);

    const third = await sentinel(turnCtx);
    expect(third.directive).toBe('proceed');
    expect(ghostedSteers(state)).toHaveLength(1);
    expect(noteTerminalAnswer).not.toHaveBeenCalled();
  });

  it('a promoted turn on CHATTER is still silence: REG-3 is not widened by any of this', async () => {
    claimedAsk();
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, inboundClassifiedAsWork: false });
    await promote(THE_ANSWER, turnCtx);
    const out = await sentinel(turnCtx);
    expect(out.directive).toBe('proceed');
    expect(ghostedSteers(state)).toHaveLength(0);
  });
});
