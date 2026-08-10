// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T19 / D1 — THE REMINDER THE PLATFORM DESTROYED.
//
// 2026-08-10 13:45Z. A reminder fired, a turn ran, and the model wrote `routine.` — twice —
// each time in the SAME model response as a `work_update` call, exactly the shape the engine's
// own steer asks for (*"Send the thing itself now … and THEN call work_update"*). Both landed
// as `[working-note]` rows (seq 59887 / 59890) and the owner heard nothing.
//
// G-SUP-2's capture arm exists for precisely this — its own comment says *"if the turn ends
// with no proper tool-less reply, the finalize block recovers it so the ask is never silently
// dropped"* — but it is gated on `hasUnansweredUser`, and `turn-classification.ts` states in
// so many words that *"Engine events and A2A are not human conversations, so they never make
// this true."* A scheduled reminder is the one case where a human IS waiting and no unanswered
// chat row exists.
//
// ── WHAT CHANGES AND WHAT DOES NOT ──
// The empirical claim in the header above the arm — *"every legitimate reply is tool-less"* —
// was measured on USER turns and stays the rule there. This turn is its recorded
// counterexample: a run that OWES a person a message (`work/deliverable-declaration.ts`, the
// closed declared inventory) is a turn whose text-with-tools MIGHT be the whole point of the
// turn. Demote-don't-discard (owner 2026-07-10) is untouched: the note is still written, the
// streamed bubble is still converted; the only change is that the words are also REMEMBERED so
// finalize can recover them.
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

import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';
import { DELIVERABLE_OWING_TASK_KINDS } from '../../../../../work/deliverable-declaration.js';

const AGENT = 'kevin';

interface TurnBag {
  deferredUserReplyWithTools: string | null;
  [k: string]: unknown;
}

function turnCtxFor(over: Record<string, unknown> = {}): TurnBag {
  return {
    agentId: AGENT,
    kind: 'user',
    convKey: 'ck-1',
    conversationId: 'conv-1',
    root: undefined,
    servedWork: undefined,
    deferredUserReplyWithTools: null,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    startAckSteerArmedThisTurn: false,
    ...over,
  } as unknown as TurnBag;
}

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[] }> = {},
): PostCallClassifyContext['result'] => ({
  content: 'routine.',
  toolCalls: [{ id: 'tc1', name: 'work_update', input: { action: 'status', status: 'complete' } }] as ToolCall[],
  inputTokens: 10, outputTokens: 5, stopReason: 'tool_use', ...over,
} as unknown as PostCallClassifyContext['result']);

function ctxFor(turnCtx: TurnBag, over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext {
  return {
    agentId: AGENT,
    turnCtx: turnCtx as unknown as PostCallClassifyContext['turnCtx'],
    turnNumber: 4602,
    db: fakeDb,
    agent: { id: AGENT, name: 'Kevin' } as unknown as PostCallClassifyContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    // THE INCIDENT'S OWN VALUE: a scheduler turn never has an unanswered chat row.
    hasUnansweredUser: false,
    triggerRow: null,
    isA2ATurn: false,
    isEngineTurn: true,
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
    result: modelResult(),
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
    persistedContent: null,
    interAgentTurn: false,
    deliberateSurfaceTurn: false,
    deliveredAsStartLine: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'floor',
    ...over,
  };
}

const REMINDER_TURN = {
  root: { kind: 'occurrence', id: 'occ-8a981511', sourceMessageId: null },
  servedWork: { taskId: 'task-bc7978d3', runId: 'occ-8a981511', taskKind: 'reminder', originConvKey: 'ck-1' },
};

let state: AgentTurnState;
beforeEach(() => {
  broadcastSpy.mockClear();
  insertMessageIfAbsentSpy.mockClear();
  state = initState({ maxToolLoops: 20 } as Parameters<typeof initState>[0]);
});

describe('D1 — a scheduler turn serving a user-deliverable run remembers the words the model wrote', () => {
  it('the reminder text that rode with work_update is DEFERRED, not lost (the incident)', async () => {
    const turnCtx = turnCtxFor(REMINDER_TURN);
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(turnCtx.deferredUserReplyWithTools).toBe('routine.');
  });

  it('demote-don\'t-discard is untouched: the [working-note] row is still written', async () => {
    const turnCtx = turnCtxFor(REMINDER_TURN);
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    const kinds = insertMessageIfAbsentSpy.mock.calls.map((c) => (c[0] as { role?: string }).role);
    expect(kinds).toContain('system');
  });

  it('the turn\'s own text is still NOT surfaced as a mid-turn bubble (preamble leak stays shut)', async () => {
    const turnCtx = turnCtxFor(REMINDER_TURN);
    const out = await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(out.directive).toBe('proceed');
  });

  it('CONTROL: the same shape on an ORDINARY engine turn (no deliverable-owing run) is unchanged', async () => {
    const turnCtx = turnCtxFor({
      root: { kind: 'engine', id: 'ev-1', sourceMessageId: null },
      servedWork: undefined,
    });
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
  });

  it('CONTROL: a run whose task owes NOBODY a message (a nightly backup) is unchanged', async () => {
    const turnCtx = turnCtxFor({
      root: { kind: 'occurrence', id: 'occ-2', sourceMessageId: null },
      servedWork: { taskId: 't2', runId: 'occ-2', taskKind: 'backup', originConvKey: null },
    });
    await runTerminalText(state, ctxFor(turnCtx), scratchFor());
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
  });

  it('CONTROL: an INTER-AGENT turn keeps the hard suppression, deliverable run or not', async () => {
    const turnCtx = turnCtxFor(REMINDER_TURN);
    await runTerminalText(state, ctxFor(turnCtx), scratchFor({ interAgentTurn: true }));
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
  });

  it('CONTROL: a waiting human still captures exactly as before (G-SUP-2\'s original arm)', async () => {
    const turnCtx = turnCtxFor();
    await runTerminalText(state, ctxFor(turnCtx, { hasUnansweredUser: true }), scratchFor());
    expect(turnCtx.deferredUserReplyWithTools).toBe('routine.');
  });

  it('CONTROL: tool-LESS text on a reminder turn is the ordinary terminal reply, never deferred', async () => {
    const turnCtx = turnCtxFor(REMINDER_TURN);
    const out = await runTerminalText(
      state, ctxFor(turnCtx, { result: modelResult({ toolCalls: [] as ToolCall[] }) }), scratchFor(),
    );
    expect(turnCtx.deferredUserReplyWithTools).toBeNull();
    expect(out.directive).toBe('proceed');
  });

  it('the deliverable question is asked of the DECLARED inventory, never of a retyped list', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../terminal-text.ts'), 'utf8');
    expect(src).toContain('DELIVERABLE_OWING_TASK_KINDS');
    expect(src).not.toContain("taskKind === 'reminder'");
    expect(DELIVERABLE_OWING_TASK_KINDS).toContain('reminder');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE STEER AND THE WAKE — both engine texts pointed the model straight at the trap.
// Tail-side strings only: neither rides the cached prompt prefix.
// ══════════════════════════════════════════════════════════════════════════════
describe('the engine stops asking for the shape it destroys', () => {
  it('the run-deliver steer asks for a SEPARATE tool-less reply first', async () => {
    const { runDeliverSteerText } = await import('../../../../../work/run-deliver-drive.js');
    const text = runDeliverSteerText({
      taskId: 't1', taskTitle: 'Reminder: routine', taskKind: 'reminder', attempt: 1, bound: 3,
    });
    expect(text).not.toContain('and THEN call');
    expect(text.toLowerCase()).toContain('separate');
    // and it still names the tool and the bound, so nothing was lost in the rewording
    expect(text).toContain('work_update(action="status")');
    expect(text).toContain('steer 1 of 3');
  });

  it('the reminder wake asks for the reply as its own response, bookkeeping after', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../../../../../scheduler/runner.ts'), 'utf8');
    const wake = src.slice(src.indexOf('[Reminder due]'), src.indexOf('[Scheduled Task, Run #'));
    expect(wake).toContain('Reminder due');
    expect(wake).not.toContain("When you're done speaking, silently call");
    expect(wake.toLowerCase()).toContain('separate response');
  });
});
