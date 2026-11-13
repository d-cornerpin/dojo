// v3.5 field fix 3, audit round (#11, V11): THE ENGINE STEERS, IT DOES NOT SUPPRESS THE AGENT'S REPLY.
//
// Two floors nulled the agent's final reply: a line of 30 characters or less after the turn already
// delivered (and `chat:retract`ed it off the screen), and a reply that looked like one sent in the last
// five. Owner law: engine detects, agent
// speaks. Each floor now holds the line (demoted to a working note, never discarded), states the fact to
// the agent once, and lets the agent decide; a reply written again after the fact goes out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import {
  POST_CALL_CLASSIFY_PHASE,
  type PostCallClassifyContext,
} from '../index.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

// ── The step's outside world ──
// Each mock stands in for a DOOR the span already went through; none of them changes
// a decision.
const { delivered } = vi.hoisted(() => ({ delivered: { value: false } }));
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const insertMessageIfAbsentSpy = vi.fn();
const insertEngineEventIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
  insertEngineEventIfAbsent: (...a: unknown[]) => insertEngineEventIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../answered-edge.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), turnDeliveredToPerson: () => delivered.value }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));

// A unit test must not open the dev database. Every DB reader in this span is a door
// it already went through inside the loop; the stub answers nothing.
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const reArmIfStrandedNoAnswerSpy = vi.fn();
const noteTerminalAnswerSpy = vi.fn();
const deliverEngineUserAckSpy = vi.fn(async () => undefined);
const persistAndBroadcastSystemRowSpy = vi.fn();
const startAckRepliedNowSpy = vi.fn(() => false);

function turnCtxFor(over: Record<string, unknown> = {}): PostCallClassifyContext['turnCtx'] {
  return {
    agentId: FXID.n4,
    kind: 'user',
    convKey: 'ck-1',
    conversationId: 'conv-1',
    servedWork: undefined,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    voiceFillerFired: false,
    goingIdleDetectorRanThisTurn: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    phoneStreamCallSid: null,
    ...over,
  } as unknown as PostCallClassifyContext['turnCtx'];
}

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: 'Here is the answer.', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

function ctxFor(over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: FXID.n4,
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    agent: { id: FXID.n4, name: FX.n4 } as unknown as PostCallClassifyContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    isA2ATurn: false,
    isEngineTurn: false,
    isHumanContinuation: false,
    mostRecentIsA2A: false,
    mostRecentInbound: undefined,
    pendingEngineEvent: null,
    unrepliedAssign: null,
    a2aReplyContext: null,
    a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false,
    waitingConvs: [],
    inboundChannel: 'dashboard',
    latestUserSource: 'dashboard',
    lastUserMessageContent: 'what is the answer?',
    configuredModelId: 'test-model',
    turnStartedAt: new Date().toISOString(),
    messageId: 'msg-1',
    result: modelResult(),
    maxToolLoops: 75,
    reArmIfStrandedNoAnswer: reArmIfStrandedNoAnswerSpy,
    noteTerminalAnswer: noteTerminalAnswerSpy,
    deliverEngineUserAck: deliverEngineUserAckSpy,
    persistAndBroadcastSystemRow: persistAndBroadcastSystemRowSpy,
    startAckRepliedNow: startAckRepliedNowSpy,
    ...over,
  } as PostCallClassifyContext;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  // The reducer's own constructor, called with its own parameter object rather than
  // positionally: `state.modelId` is one of this step's four outputs, so a state built
  // sloppily would make that output read `undefined` and the clause prove nothing.
  const base = initState({
    agentId: FXID.n4, contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'what is the answer?',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: POST_CALL_CLASSIFY_PHASE, loopCount: 2, modelId: 'test-model', ...over });
}


import { runCloseoutFloors } from '../closeout-floors.js';
import { runReplyFloors } from '../reply-floors.js';
import { steerFired } from '../../../steer-queue.js';
import type { PostCallScratch } from '../index.js';

const scFor = (text: string): PostCallScratch => ({ persistedContent: text, deliberateSurfaceTurn: false, interAgentTurn: false } as unknown as PostCallScratch);
const retracted = (): boolean => broadcastSpy.mock.calls.some((c) => (c[0] as { type?: string })?.type === 'chat:retract');
const dbWithRecentReply = (content: string): PostCallClassifyContext['db'] => ({
  prepare: (sql: string) => (/role = 'assistant'/.test(sql) ? { ...emptyStmt, all: () => [{ content }] } : emptyStmt),
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db']);

describe('the 30-character closeout after a delivery is steered, not retracted', () => {
  it('THE RED: first time the floor fires, the line is held (not retracted) and the agent is told; written again, it goes out', async () => {
    delivered.value = true;
    const sc = scFor('All set.');
    const out = runCloseoutFloors(freshState(), ctxFor({ result: modelResult({ content: 'All set.' }) }), sc);
    expect(retracted()).toBe(false);
    expect(out.directive).toBe('continue');
    expect(steerFired(out.state.steerQueue, 'redundant-closeout')).toBe(true);
    const sc2 = scFor('All set.');
    runCloseoutFloors(out.state, ctxFor({ result: modelResult({ content: 'All set.' }) }), sc2);
    expect(sc2.persistedContent).toBe('All set.');
  });
});

describe('a near-duplicate reply is steered, not nulled', () => {
  it('THE RED: the agent is told it matches a sent reply; written again, it goes out', async () => {
    const text = 'Dry cleaning set for 6pm, dentist not found.';
    const ctx = ctxFor({ db: dbWithRecentReply(text), hasUnansweredUser: false, result: modelResult({ content: text }) });
    const sc = scFor(text);
    const out = await runReplyFloors(freshState(), ctx, sc);
    expect(out.directive).toBe('continue');
    expect(steerFired(out.state.steerQueue, 'near-duplicate-reply')).toBe(true);
    const sc2 = scFor(text);
    await runReplyFloors(out.state, ctx, sc2);
    expect(sc2.persistedContent).toBe(text);
  });
});
