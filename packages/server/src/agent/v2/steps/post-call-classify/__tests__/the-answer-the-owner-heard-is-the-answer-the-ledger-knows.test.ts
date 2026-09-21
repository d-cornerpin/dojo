// ════════════════════════════════════════════════════════════════════════════════════════
// ANSWER-ANYWAY — THE OWNER HEARD IT, SO THE LEDGER KNOWS IT.
//
// THE INCIDENT, from the engine's own rows (release ritual v3.1.26 round 3, seed
// `eceef8a09723`, scenario `gen-web-research-with-sourcing-eceef8a09723-5`, run `bmub8ip5nhy`,
// agent turn 5649, ask `695067c2`):
//
//   12:45:10  "Research the current state of e-ink tablets … cite sources again this time."
//   12:45:40  the start-ack threshold passes with nothing heard   -> steer requested
//   12:46:23  "start-ack steer: model spoke its start line mid-work; delivered as the visible
//              ack (streamed bubble promoted in place)"
//              preview: "Fresh sources pulled just now (Sep 21, 2026). US prices, as …"
//              — four tablets, three dimensions, ten web calls behind it: THE ANSWER
//   12:46:26  "agent ended turn silently via [no-reply] sentinel"  — correct from its seat
//   12:46:28  "ask re-opened: its turn finalized without delivering an answer"  (serve 1)
//   12:46:30 / 12:46:33                                                        (serves 2, 3)
//   12:46:36  ERROR "ask re-serve STOOD DOWN" (serves 4, bound 4); the ask ends `blocked`
//
// A correct answer reached the owner; the ledger recorded silence; the engine re-served a
// settled question four times into an agent that had already answered it and then parked the
// request. This is t82's dual — when the user HAS heard, the engine must know.
//
// ── WHAT THIS FILE DRIVES, AND WHY IT IS ONE FILE ──
// The defect lives in the gap between two subsystems that were each correct alone, so the
// tests walk it end to end on a REAL database: the promotion writes the bubble and the
// delivery the way the live doors do, the `[no-reply]` sentinel's own reply rule runs, the
// turn record is finalized off the key that rule sets, and the settlement authority is then
// asked for its verdict. Nothing is asserted about an intermediate belief that the owner
// cannot see the consequences of.
//
// THE DOOR IS `turns.answer_message_id` — the truthful-answer key, ONE setter — and it is the
// door every delivered utterance already passes through to become settlement-visible (the
// authority's sixth narrowing reads it, the draft re-classifier reads it, the ticket stamps
// read it). The promoted bubble never reached it, because the promotion consumed
// `deferredUserReplyWithTools` and latched `deferredDeliveredByAck`, which between them
// silence the one rule that decides whether captured text-with-tools is the turn's reply.
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

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage, insertMessageIfAbsent, START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../../../../../work/store.js';
import { settleAsk, settleAsksAtTurnFinalize, MAX_ASK_RE_SERVES } from '../../../../../work/ask-settlement.js';
import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { runNoReply } from '../no-reply.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

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

/**
 * THE REAL DOOR, in the two rows it produces. `deliverEngineUserAck` persists the bubble
 * (assistant / owner lane / explicit `agent-text` / the start-ack stamp) and broadcasts it;
 * `broadcast` then records the dashboard delivery (`agent/v2/outbound.ts`'s dashboard door).
 * Both are written here so the authority below is asked about the rows the live path writes.
 */
const deliverEngineUserAck = vi.fn(
  async (text: string, originIntent: string | null, reuseId: string | null, displayKind: string | null) => {
    const id = reuseId ?? 'minted-by-the-closure';
    insertMessageIfAbsent({
      id, agentId: AGENT, role: 'assistant', content: text, turnNumber: TURN,
      originIntent, conversationId: CONV,
      ...(displayKind ? { displayKind: displayKind as 'agent-text' } : {}),
    } as never);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                               message_id, outcome, created_at)
       VALUES (?, ?, ?, 'dashboard', 'dashboard', ?, ?, 'delivered', datetime('now'))`,
    ).run(`d-${id}`, AGENT, TURN, CONV, id);
  },
);

const noteTerminalAnswer = vi.fn();

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
    persistAndBroadcastSystemRow: vi.fn(),
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

let state: AgentTurnState;

/** Turn 5649, whole: the ack is owed, the model speaks WITH a tool call, and then ends. */
async function driveThePromotedTurn(
  text: string, opts: { endsWithNoReply?: boolean; turnCtx?: Bag } = {},
): Promise<Bag> {
  const turnCtx = opts.turnCtx ?? turnCtxFor({ startAckSteerRequested: true });
  await runTerminalText(state, ctxFor(turnCtx, { result: modelResult({ content: text }) }), scratchFor());
  if (opts.endsWithNoReply !== false) {
    await runNoReply(
      state,
      ctxFor(turnCtx, { result: modelResult({ content: '[no-reply]', toolCalls: [] as ToolCall[] }) }),
      scratchFor({ persistedContent: '[no-reply]' }),
    );
  }
  return turnCtx;
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
  broadcastSpy.mockClear(); deliverEngineUserAck.mockClear(); noteTerminalAnswer.mockClear();
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (a) THE LIVE SHAPE — the answer arrives through the promotion, and the ask SETTLES on it
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(a) the shape the ritual caught: the answer rode the promotion, and the ask settles on it', () => {
  it('RED→GREEN: turn 5649 end to end — settled, zero re-serves, no stand-down, never blocked', async () => {
    const workId = claimedAsk();
    const turnCtx = await driveThePromotedTurn(THE_ANSWER);

    // The promotion happened exactly as it does today, and it NAMED the row it delivered.
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(turnCtx.deferredDeliveredByAck).toBe(true);
    expect(turnCtx.startAckPromotedRowId).toEqual(expect.any(String));
    const rowId = turnCtx.startAckPromotedRowId as string;

    // MID-TURN NOTHING CLOSES — T2's whole point, and it is untouched: while the turn is
    // running nobody can know which bubble was the answer.
    expect(settleAsk(workId, { agentId: AGENT, turnNumber: TURN, at: 'delivery' }).verdict)
      .toBe('unchanged');
    expect(askRow(workId).state).toBe('claimed');

    // THE DOOR: the `[no-reply]` reply rule named the bubble the person actually heard.
    expect(noteTerminalAnswer).toHaveBeenCalledTimes(1);
    expect(noteTerminalAnswer.mock.calls[0]![0]).toBe(rowId);
    expect(finalizeTurnRecord()).toBe(rowId);

    // THE VERDICT.
    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });
    expect(r).toEqual({ closed: 1, held: 0, reopened: 0 });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe(`d-${rowId}`);
    // …and none of the four symptoms the ritual recorded.
    expect(markersFor(workId)).not.toContain('ct0_ask_re_served');
    expect(transitionsFor(workId).map((t) => t.to)).toEqual(['claimed', 'done']);
  });

  it('the owner is not told twice: the promotion still delivers exactly ONE bubble, and the naming adds none', async () => {
    claimedAsk();
    const turnCtx = await driveThePromotedTurn(THE_ANSWER);
    expect(deliverEngineUserAck).toHaveBeenCalledTimes(1);
    const bubbles = mockDb.current!.prepare(
      `SELECT id, content, origin_intent, display_kind FROM messages
        WHERE agent_id = ? AND role = 'assistant' AND turn_number = ?`,
    ).all(AGENT, TURN) as Array<{ id: string; content: string; origin_intent: string; display_kind: string }>;
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.id).toBe(turnCtx.startAckPromotedRowId);
    expect(bubbles[0]!.content).toBe(THE_ANSWER);
    // The stamp and the explicit kind are UNCHANGED — the fix removed a blanket refusal, not
    // the record of what the lane did.
    expect(bubbles[0]!.origin_intent).toBe(START_ACK_ORIGIN_INTENT);
    expect(bubbles[0]!.display_kind).toBe('agent-text');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (b) THE MATCHED CONTROL — a status line is still not an answer
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(b) the same door, a status-line-only ack: nothing settles and the re-serve fires as today', () => {
  it('"On it — pulling sources now" + [no-reply] names nothing, and the ask is served again', async () => {
    const workId = claimedAsk();
    const turnCtx = await driveThePromotedTurn(THE_STATUS_LINE);

    // The person heard it — the promotion is unchanged and the bubble exists.
    expect(deliverEngineUserAck).toHaveBeenCalledTimes(1);
    expect(turnCtx.startAckPromotedRowId).toEqual(expect.any(String));
    // But the platform's own "is this a substantive, model-authored reply" question says no,
    // so the key is never set and the turn ends exactly as it does today.
    expect(noteTerminalAnswer).not.toHaveBeenCalled();
    expect(finalizeTurnRecord()).toBeNull();

    const r = settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });
    expect(r).toEqual({ closed: 0, held: 0, reopened: 1 });
    expect(askRow(workId).state).toBe('open');
    expect(askRow(workId).result_delivery_id).toBeNull();
    expect(markersFor(workId)).toEqual(['ct0_ask_re_served']);
    expect(transitionsFor(workId).at(-1)!.reason)
      .toContain(`serve 2 of ${MAX_ASK_RE_SERVES + 1}`);
  });

  it('and the authority refuses that bubble as evidence even when asked for it directly', async () => {
    const workId = claimedAsk();
    const turnCtx = await driveThePromotedTurn(THE_STATUS_LINE);
    finalizeTurnRecord();
    // The seventh narrowing keeps its bite on every stamped row the finished turn does not
    // call its answer — which is every status line, and every ack of an ack-only turn.
    const { askAnswerEvidence } = await import('../../../../../work/ask-settlement.js');
    expect(askAnswerEvidence(workId, TURN)).toBeNull();
    expect(turnCtx.startAckPromotedRowId).toEqual(expect.any(String));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// (c) GENUINE SILENCE — the t82 machinery, whole and byte-identical
// ════════════════════════════════════════════════════════════════════════════════════════

describe('(c) genuine silence: no promotion, nothing delivered, and the ladder runs to its bound unchanged', () => {
  it('the re-serve chain and the STOOD-DOWN wording are what they were', async () => {
    const workId = claimedAsk();
    // A turn that says nothing to anybody: no text with the tool call, so nothing to promote.
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(
      state, ctxFor(turnCtx, { result: modelResult({ content: null as unknown as string }) }), scratchFor(),
    );
    await runNoReply(
      state,
      ctxFor(turnCtx, { result: modelResult({ content: '[no-reply]', toolCalls: [] as ToolCall[] }) }),
      scratchFor({ persistedContent: '[no-reply]' }),
    );
    expect(deliverEngineUserAck).not.toHaveBeenCalled();
    expect(turnCtx.startAckPromotedRowId).toBeNull();
    expect(noteTerminalAnswer).not.toHaveBeenCalled();
    finalizeTurnRecord();

    // Serve 1 of the ladder, from this turn.
    expect(settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN })).toEqual({
      closed: 0, held: 0, reopened: 1,
    });
    // …and the remaining rungs, each a turn that finalized with nothing delivered.
    for (let i = 1; i <= MAX_ASK_RE_SERVES; i++) {
      const turn = TURN + i;
      claimAsk(workId, AGENT); stampClaimingTurn(workId, turn);
      finalizeTurnRecord(turn);
      settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn });
    }
    expect(askRow(workId).state).toBe('blocked');
    const last = transitionsFor(workId).at(-1)!;
    expect(last.reason).toBe(
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
    // Tool-less text is the reply itself: `terminal-text` hands it straight on, nothing is
    // promoted, and the ordinary persist seam is what names it.
    const sc = scratchFor();
    await runTerminalText(
      state, ctxFor(turnCtx, { result: modelResult({ content: THE_ANSWER, toolCalls: [] as ToolCall[] }) }), sc,
    );
    expect(sc.persistedContent).toBe(THE_ANSWER);
    expect(deliverEngineUserAck).not.toHaveBeenCalled();
    expect(turnCtx.startAckPromotedRowId).toBeNull();

    // The row and the receipt the ordinary door writes — no stamp, because the model spoke
    // for itself.
    insertMessageIfAbsent({
      id: 'msg-reply', agentId: AGENT, role: 'assistant', content: THE_ANSWER,
      turnNumber: TURN, conversationId: CONV,
    } as never);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                               message_id, outcome, created_at)
       VALUES ('d-reply', ?, ?, 'dashboard', 'dashboard', ?, 'msg-reply', 'delivered', datetime('now'))`,
    ).run(AGENT, TURN, CONV);

    expect(settleAsk(workId, { agentId: AGENT, turnNumber: TURN, at: 'delivery' }).verdict).toBe('closed');
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-reply');
  });

  it('CONTROL — acked FIRST and answered after: the ask settles on the ANSWER, never on the ack', async () => {
    const workId = claimedAsk();
    const turnCtx = await driveThePromotedTurn(THE_STATUS_LINE, { endsWithNoReply: false });
    const ackRowId = turnCtx.startAckPromotedRowId as string;
    // The work finishes and the model speaks for itself.
    insertMessageIfAbsent({
      id: 'msg-reply', agentId: AGENT, role: 'assistant', content: THE_ANSWER,
      turnNumber: TURN, conversationId: CONV,
    } as never);
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id,
                               message_id, outcome, created_at)
       VALUES ('d-reply', ?, ?, 'dashboard', 'dashboard', ?, 'msg-reply', 'delivered', datetime('now', '+8 seconds'))`,
    ).run(AGENT, TURN, CONV);
    noteTerminalAnswer('msg-reply', 'a genuine terminal reply');
    finalizeTurnRecord();

    settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: TURN });
    expect(askRow(workId).state).toBe('done');
    expect(askRow(workId).result_delivery_id).toBe('d-reply');
    expect(askRow(workId).result_delivery_id).not.toBe(`d-${ackRowId}`);
  });
});
