// Text the model writes beside a tool call: on a turn nobody waits on it is the agent's own working note; on an
// inter-agent turn it is suppressed; with no tool call it is the reply; with an ack owed and a person waiting it
// goes out as the ack; with a person waiting it is kept for the finalize to deliver if no reply follows.

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

import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/message-store.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-one';
/** The incident's own text, opening line for opening line (S5 §8.11). */
const THE_PLAN = "Here's the combined day plan — both research pieces merged:\n\n"
  + '# Saturday Day Plan — Seattle ↔ Leavenworth with the Dog (September 2026)\n\n'
  + '**~7:00–7:30 AM — Leave Seattle.** Take I-90 E → Snoqualmie Pass → US-2 W into Leavenworth.';

interface Bag { [k: string]: unknown }

const turnCtxFor = (over: Record<string, unknown> = {}): Bag => ({
  // Turn 4902's own shape: `kind` null, `subject_kind` 'none' — a bare engine wake, not
  // attached to the ask or to a thread — on the owner's conversation.
  agentId: AGENT, kind: null, convKey: 'owner', conversationId: '616f857b-2026-44f3-b64e-943032f913ec',
  root: undefined, servedWork: undefined,
  deferredUserReplyWithTools: null, deferredDeliveredByAck: false,
  engineStartAckDeliveredThisTurn: false,
  startAckSteerArmedThisTurn: false, startAckSteerRequested: false,
  startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null,
  ...over,
});

const modelResult = (over: Partial<{ content: string; toolCalls: ToolCall[] }> = {}): PostCallClassifyContext['result'] => ({
  content: THE_PLAN,
  // The incident's own pairing: the whole answer, and `work_update` in the same round.
  toolCalls: [{ id: 'call_00_wPufybMRgPOvILAavOPS8077', name: 'work_update', input: {} }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

const deliverAckSpy = vi.fn(async () => undefined);
const noteTerminalAnswerSpy = vi.fn();

function ctxFor(turnCtx: Bag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: 4902, db: fakeDb,
    agent: { id: AGENT, name: 'HarnessBot' } as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false,
    chosenConvKey: 'owner',
    // Turn 4902 carried NO waiting chat row: the owner's ask was acknowledged sixteen
    // minutes earlier. This is the flag that made all of T19's openers false.
    hasUnansweredUser: false,
    triggerRow: null, isA2ATurn: false, isEngineTurn: true, isHumanContinuation: false,
    mostRecentIsA2A: false, mostRecentInbound: undefined, pendingEngineEvent: null,
    unrepliedAssign: null, a2aReplyContext: null, a2aReplyAssignMessageId: null,
    settledContextWakeTurn: false, waitingConvs: [], inboundChannel: null,
    latestUserSource: null, lastUserMessageContent: 'plan me a Saturday in Leavenworth with the dog',
    configuredModelId: 'deepseek-v4-flash', turnStartedAt: new Date().toISOString(), messageId: 'msg-65934',
    result: modelResult(),
    reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: noteTerminalAnswerSpy,
    deliverEngineUserAck: deliverAckSpy,
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

const scratchFor = (over: Partial<PostCallScratch> = {}): PostCallScratch => ({
  persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'deepseek-v4-flash',
  ...over,
});

const notesWritten = (): string[] => insertMessageIfAbsentSpy.mock.calls
  .map((c) => (c[0] as { role?: string; content?: string }))
  .filter((m) => m.role === 'system')
  .map((m) => m.content ?? '');

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear(); insertMessageIfAbsentSpy.mockClear(); deliverAckSpy.mockClear();
  noteTerminalAnswerSpy.mockClear(); injectRegistryMessageSpy.mockClear();
  state = initState({ agentId: AGENT } as Parameters<typeof initState>[0]);
});

describe('text beside a tool call', () => {
  it('CONTROL — narration on a normal turn is a working note', async () => {
    const turnCtx = turnCtxFor();
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx), sc);
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toHaveLength(1);
    // No person is waiting on this turn, so the note is the agent's own record.
    expect(notesWritten()[0]).toContain('[working-note:internal]');
    expect(notesWritten()[0]).toContain(THE_PLAN);
    expect(sc.persistedContent).toBeNull();
  });

  it('CONTROL — an A2A turn keeps its hard suppression', async () => {
    // The 2026-07-23 lane rule at its own arm: inter-agent narration never streamed to the
    // person, so there is nothing to demote and nothing to promote.
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx), scratchFor({ interAgentTurn: true }));
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
  });

  it('CONTROL — a normal tool-less answer is untouched', async () => {
    const sc = scratchFor();
    await runTerminalText(
      state,
      ctxFor(turnCtxFor(), { result: modelResult({ toolCalls: [] as ToolCall[] }) }),
      sc,
    );
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(notesWritten()).toEqual([]);
    // the text IS the reply and flows on to the ordinary persist, exactly as it always did
    expect(sc.persistedContent).toBe(THE_PLAN);
  });

  it('CONTROL — the owed-ACK window promotes the text as an ack', async () => {
    const turnCtx = turnCtxFor({ startAckSteerRequested: true });
    const sc = scratchFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), sc);
    expect(deliverAckSpy).toHaveBeenCalledTimes(1);
    // The stamp and the explicit display kind travel together, and this is still not an answer here.
    expect(deliverAckSpy.mock.calls[0]).toEqual([THE_PLAN, START_ACK_ORIGIN_INTENT, null, 'agent-text']);
    expect(turnCtx.engineStartAckDeliveredThisTurn).toBe(true);
    expect(sc.deliveredAsStartLine).toBe(true);
    expect(noteTerminalAnswerSpy).not.toHaveBeenCalled();
  });

  it('CONTROL — a waiting human keeps the text for the finalize', async () => {
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), scratchFor());
    expect(deliverAckSpy).not.toHaveBeenCalled();
    expect(turnCtx.deferredUserReplyWithTools).toBe(THE_PLAN);
    expect(notesWritten()).toHaveLength(1);
  });
});
