// ════════════════════════════════════════════════════════════════════════════════
// t172 B — A CONTINUATION TURN'S WORKING NOTE IS NOT THE OWNER'S TO READ.
//
// A long job's owner chat holds the acknowledgement and the result only. The run that
// produced this fix walked a 599-page chain over many engine-continued turns; at turn 6 the
// model narrated "I've located the final page ... Continuing the walk" in the same response as
// a tool call, the engine demoted it to a `[working-note]` system row, and that row was
// owner-visible. Another row on the same agent was nothing but the turn's own label text
// echoed back ("[<instant> · background wake — not part of any conversation]").
//
// THE RULE UNDER TEST: whether a demoted note reaches the owner is decided by what the TURN
// is serving (structured turn facts), never by what the note says.
//   * a turn a person is waiting on  -> today's visibility, unchanged
//   * every other turn (engine continuation, park resume, a2a, background wake) -> agent-only
//   * a note that is only the turn's label text -> not persisted at all
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

const insertMessageIfAbsentSpy = vi.fn();
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../../../services/imessage-bridge.js', () => ({
  stripSystemTags: (s: string) => s,
}));

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

import { INTERNAL_WORKING_NOTE_PREFIX, WORKING_NOTE_PREFIX } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import { renderRowLabel, LabelFacts, type LabelledMessage } from '../../../../../memory/row-label.js';

const AGENT = 'agent-t172';

const NARRATION = "I've located the final page. Continuing the walk to confirm it.";

function turnCtxFor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: AGENT, kind: 'user', convKey: null, conversationId: null, root: undefined,
    servedWork: undefined, deferredUserReplyWithTools: null, engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false, startAckSteerArmedThisTurn: false, ...over,
  };
}

const modelResult = (content: string): PostCallClassifyContext['result'] => ({
  content,
  toolCalls: [{ id: 'tc1', name: 'file_read', input: { path: '/x/page-9.txt' } }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use',
} as unknown as PostCallClassifyContext['result']);

function ctxFor(turnCtx: Record<string, unknown>, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnCtx: turnCtx as unknown as PostCallClassifyContext['turnCtx'],
    turnNumber: 6,
    db: fakeDb,
    agent: { id: AGENT, name: 'Agent' } as unknown as PostCallClassifyContext['agent'],
    // The engine synthesizes a USER-SHAPED owner counterparty for every non-a2a turn, a
    // continuation included; it is exactly why the counterparty cannot be the signal here.
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: null,
    hasUnansweredUser: false,
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
    latestUserSource: null,
    lastUserMessageContent: null,
    configuredModelId: 'floor',
    turnStartedAt: new Date().toISOString(),
    messageId: 'msg-1',
    result: modelResult(NARRATION),
    maxToolLoops: 20,
    reArmIfStrandedNoAnswer: vi.fn(),
    noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined),
    persistAndBroadcastSystemRow: vi.fn(),
    startAckRepliedNow: () => false,
    ...over,
  } as unknown as PostCallClassifyContext;
}

function scratchFor(over: Partial<PostCallScratch> = {}): PostCallScratch {
  return {
    persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
    deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor', ...over,
  };
}

/** The `[working-note…]` system rows the section wrote. */
function noteRows(): Array<{ content: string }> {
  return insertMessageIfAbsentSpy.mock.calls
    .map((c) => c[0] as { role?: string; content: string })
    .filter((r) => r.role === 'system');
}
function noteFrames(): Array<{ internal?: boolean; content: string }> {
  return broadcastSpy.mock.calls
    .map((c) => c[0] as { type?: string; internal?: boolean; content: string })
    .filter((f) => f.type === 'chat:workingnote');
}

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear();
  insertMessageIfAbsentSpy.mockClear();
  state = initState({ maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

describe('(iv) a working note follows the turn that wrote it', () => {
  it('an engine continuation (no person waiting, no conversation) writes an AGENT-ONLY note', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor()), scratchFor());
    const rows = noteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
    expect(noteFrames()[0]?.internal).toBe(true);
  });

  it('a human-task continuation (the engine re-entering a person\'s job with nothing new from them) is agent-only too — once its first utterance has gone out as the answer', async () => {
    // The never-silent backstop (answer-to-a-live-ask.ts) still delivers a continuation's FIRST
    // text as the answer; every later narration line is the note under test.
    state = advance(state, { surfacedReplyThisTurn: true });
    await runTerminalText(state, ctxFor(turnCtxFor(), { isHumanContinuation: true, chosenConvKey: 'ck-1' }), scratchFor());
    expect(noteRows()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
    expect(noteFrames()[0]?.internal).toBe(true);
  });

  it('a background wake (settled-context wake) is agent-only', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor(), { settledContextWakeTurn: true }), scratchFor());
    expect(noteRows()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
  });

  it('CONTROL: a turn a person is waiting on keeps today\'s visibility (the unmarked note, no internal flag)', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor({ convKey: 'ck-1' }), { hasUnansweredUser: true, chosenConvKey: 'ck-1' }), scratchFor());
    const rows = noteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content.startsWith(WORKING_NOTE_PREFIX)).toBe(true);
    expect(rows[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(false);
    expect(noteFrames()[0]?.internal).toBeUndefined();
  });

  it('CONTROL: a scheduler run that owes the person a message keeps today\'s visibility', async () => {
    const turnCtx = turnCtxFor({
      root: { kind: 'occurrence', id: 'occ-1', sourceMessageId: null },
      servedWork: { taskId: 't1', runId: 'occ-1', taskKind: 'reminder', originConvKey: null },
    });
    await runTerminalText(state, ctxFor(turnCtx, { isEngineTurn: true }), scratchFor());
    expect(noteRows()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(false);
  });

  it('CONTROL: a routed-channel person (iMessage) stays agent-only exactly as before', async () => {
    await runTerminalText(
      state,
      ctxFor(turnCtxFor({ convKey: 'ck-1' }), {
        hasUnansweredUser: true, chosenConvKey: 'ck-1',
        counterparty: { kind: 'user', relation: 'owner', channel: 'imessage' } as unknown as PostCallClassifyContext['counterparty'],
      }),
      scratchFor(),
    );
    expect(noteRows()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
  });

  it('the decision never reads the note\'s words: the same text is visible on a live turn and internal off it', async () => {
    const live = ctxFor(turnCtxFor({ convKey: 'ck-1' }), { hasUnansweredUser: true, chosenConvKey: 'ck-1' });
    await runTerminalText(state, live, scratchFor());
    const off = ctxFor(turnCtxFor());
    await runTerminalText(state, off, scratchFor());
    const [a, b] = noteRows();
    expect(a.content.endsWith(NARRATION)).toBe(true);
    expect(b.content.endsWith(NARRATION)).toBe(true);
    expect(a.content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(false);
    expect(b.content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
  });
});

describe('(v) a note that is only the turn\'s label text is not persisted', () => {
  // The label is rendered by the memory layer's own formatter, so this follows its shape.
  const label = renderRowLabel(
    { role: 'assistant', content: '', createdAt: 1760000000000, subjectKind: 'background', turnNumber: null } as unknown as LabelledMessage,
    new LabelFacts(AGENT),
  );

  it('the fixture really is the label shape the model sees (guard against a vacuous test)', () => {
    expect(label.startsWith('[')).toBe(true);
    expect(label).toContain(' · ');
    expect(label).toContain('background wake');
  });

  it('a note equal to the label is dropped on an off-turn: no row, no frame', async () => {
    await runTerminalText(state, ctxFor(turnCtxFor(), { result: modelResult(label) }), scratchFor());
    expect(noteRows()).toHaveLength(0);
    expect(noteFrames()).toHaveLength(0);
  });

  it('and on a live person\'s turn too (it is never a thing to read)', async () => {
    await runTerminalText(
      state,
      ctxFor(turnCtxFor({ convKey: 'ck-1' }), { hasUnansweredUser: true, chosenConvKey: 'ck-1', result: modelResult(label) }),
      scratchFor(),
    );
    expect(noteRows()).toHaveLength(0);
  });

  it('CONTROL: a real sentence that merely mentions a bracketed time is still a note', async () => {
    const text = `${label} I am continuing the walk.`;
    await runTerminalText(state, ctxFor(turnCtxFor(), { result: modelResult(text) }), scratchFor());
    expect(noteRows()).toHaveLength(1);
  });
});
