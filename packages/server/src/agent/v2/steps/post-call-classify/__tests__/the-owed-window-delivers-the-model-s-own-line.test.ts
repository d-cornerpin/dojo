// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T41 (option B) — THE OWED WINDOW, AND NOTHING WIDER.
//
// OWNER RE-RULE, 2026-08-12, of his own 2026-07-23 ruling: **in the owed window only** — the
// start-ack threshold has passed and the person has heard nothing — a model line addressed to
// the person is PROMOTED and routed as the acknowledgment instead of being demoted to a
// working note. Outside that window the 2026-07-23 ruling stands byte-identical.
//
// WHY THE WINDOW EXISTS AT ALL: `startAckSteerRequested` ("the threshold passed with nothing
// heard") and `startAckSteerArmedThisTurn` ("the steer has been injected") are separated by a
// WHOLE MODEL CALL — the request is inert until the next loop boundary by design. On the
// owner's incident (W19, turn 4805) the engine knew at +30 s that he had heard nothing; at
// +80 s the model wrote him a TRUE line ("the exact probes can't run: sleep is blocked by my
// sandbox"); this arm, keyed on ARMED, dropped it into an internal working note that reached
// nobody; the line the steer extracted at +145 s was FALSE. Fifty seconds of that silence was
// the engine holding a sentence it had already decided the person was owed.
//
// WHAT THE 2026-07-23 DELETION FORBADE AND STILL FORBIDS (its comment survives at
// `preflight/start-ack.ts`): a branch that "delivered whatever mid-work narration was captured
// … AS the ack, SHORT-CIRCUITING THE STEER, so the model was never actually asked to address
// the user." Nothing here fires before the threshold, the words are the model's own from the
// call that just returned, and the steer is still asked for on the next boundary unless this
// delivery satisfied it — which is the second half of the fix, pinned at the bottom of this
// file.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const insertMessageIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../../../services/imessage-bridge.js', () => ({ stripSystemTags: (s: string) => s }));

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const injectRegistryMessageSpy = vi.fn(() => true);
vi.mock('../../../../../prompt/registry/assembler.js', () => ({
  injectRegistryMessage: (...a: unknown[]) => injectRegistryMessageSpy(...(a as [])),
}));

import { initState, advance, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { runSteerCheckpoint } from '../../assemble/steer-checkpoint.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'kevin';
const MID_WORK_LINE = "The exact probes can't run: sleep is blocked by my sandbox permissions.";

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  agentId: AGENT, kind: 'user', convKey: 'imessage:+1555', conversationId: 'conv-1',
  root: undefined, servedWork: undefined,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  ...over,
});

const modelResult = (over: Partial<{ content: string; toolCalls: ToolCall[] }> = {}): PostCallClassifyContext['result'] => ({
  content: MID_WORK_LINE,
  toolCalls: [{ id: 'tc1', name: 'exec', input: { command: 'ping -c1 1.1.1.1' } }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

const deliverAckSpy = vi.fn(async () => undefined);

function ctxFor(turnCtx: Bag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: 4805, db: fakeDb,
    agent: { id: AGENT, name: 'Kevin' } as never,
    // The incident's own counterparty: the owner, on iMessage.
    counterparty: { kind: 'user', relation: 'owner', channel: 'imessage', senderId: '+1555', senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'imessage:+1555',
    hasUnansweredUser: true,
    triggerRow: null, isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'imessage',
    latestUserSource: null, lastUserMessageContent: 'Did the T-Mobile internet go down?',
    configuredModelId: 'floor', turnStartedAt: new Date().toISOString(), messageId: 'msg-1',
    result: modelResult(), maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: deliverAckSpy,
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

const notesWritten = (): string[] => insertMessageIfAbsentSpy.mock.calls
  .map((c) => (c[0] as { role?: string; content?: string }))
  .filter((m) => m.role === 'system')
  .map((m) => m.content ?? '');

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear(); insertMessageIfAbsentSpy.mockClear(); deliverAckSpy.mockClear();
  injectRegistryMessageSpy.mockClear();
  state = initState({ agentId: AGENT, maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

describe('inside the owed window the person hears the model\'s own words, at the moment it says them', () => {
  it('RED→GREEN: threshold passed, steer NOT yet injected — the line is delivered as the ack', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx), sc);

    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(deliverAckSpy.mock.calls[0]).toEqual([MID_WORK_LINE, START_ACK_ORIGIN_INTENT, null, 'agent-text']);
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(turnCtx.deferredDeliveredByAck).toBe(true);
    // Consumed, so the finalize recovery cannot send the same sentence a second time.
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
    expect(sc.deliveredAsStartLine).toBe(true);
    // Promoted WHOLE — so there is nothing left to demote, and exactly one copy exists.
    expect(notesWritten()).toEqual([]);
  });

  it('the 2026-07-22 path is unchanged: an ARMED steer promotes exactly as it did', async () => {
    const turnCtx = turnCtxFor({ startAckSteerArmedThisTurn: true });
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
  });

  it('the dashboard is covered by the same window, and only by the same window (the ruling\'s own scope)', async () => {
    const dash = { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false };
    const owed = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(state, ctxFor(owed, { counterparty: dash as never }), scratchFor());
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);

    deliverAckSpy.mockClear(); insertMessageIfAbsentSpy.mockClear();
    const quiet = turnCtxFor();
    await runTerminalText(state, ctxFor(quiet, { counterparty: dash as never }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()[0]).toContain(MID_WORK_LINE);
  });
});

describe('outside the owed window the 2026-07-23 ruling stands, byte for byte', () => {
  it('CONTROL — no ack owed: the line is a working note, internal on a routed channel, and nothing is delivered', async () => {
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx), sc);
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(sc.deliveredAsStartLine).toBe(false);
    expect(notesWritten()).toHaveLength(1);
    expect(notesWritten()[0]).toContain('[working-note:internal]');
    expect(turnCtx.deferredUserReplyWithTools).toBe(MID_WORK_LINE);
  });

  it('CONTROL — an ack ALREADY delivered this turn is never followed by a second one', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, engineStartAckDeliveredThisTurn: true });
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
  });

  it('CONTROL — the person has ALREADY heard something this turn: owed or not, nothing is pushed', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(state, ctxFor(turnCtx, { startAckRepliedNow: () => true }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
  });

  it('CONTROL — an inter-agent turn keeps its hard suppression, owed window or not', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(state, ctxFor(turnCtx), scratchFor({ interAgentTurn: true }));
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
  });

  it('CONTROL — a CHAT-SHAPED turn stays quiet: tool-less text is the reply itself, never an ack', async () => {
    // The structural half of option A's hazard answer. A turn that never calls a tool cannot
    // reach this arm at all, so no early line can be manufactured beside the real reply.
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, startAckSteerArmedThisTurn: true });
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx, { result: modelResult({ toolCalls: [] as ToolCall[] }) }), sc);
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(sc.persistedContent).toBe(MID_WORK_LINE);
    expect(notesWritten()).toEqual([]);
  });

  it('CONTROL — a turn with no waiting human never promotes (G-SUP-2\'s own gate is untouched)', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: false }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
  });
});

describe('and the engine never tells the person\'s agent they heard nothing right after they heard something', () => {
  const checkpointInput = (turnCtx: Bag, delivered: boolean): Parameters<typeof runSteerCheckpoint>[1] => ({
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: 4805,
    engineStartAckDeliveredThisTurn: delivered,
    startAckRepliedNow: () => false,
    mctx: {} as never, messages: [] as never,
  });

  it('RED→GREEN: a delivered ack stands the queued steer down', () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true, engineStartAckDeliveredThisTurn: true });
    const out = runSteerCheckpoint(advance(state, { loopCount: 2 }), checkpointInput(turnCtx, true));
    expect((out.state.steerQueue as unknown as { pending: unknown[] }).pending).toEqual([]);
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('CONTROL — an UNdelivered owed ack still gets its steer, exactly as before', () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    const out = runSteerCheckpoint(advance(state, { loopCount: 2 }), checkpointInput(turnCtx, false));
    const pending = (out.state.steerQueue as unknown as { pending: Array<{ floor: string }> }).pending;
    expect(pending.map((p) => p.floor)).toEqual(['start-ack']);
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
  });
});
