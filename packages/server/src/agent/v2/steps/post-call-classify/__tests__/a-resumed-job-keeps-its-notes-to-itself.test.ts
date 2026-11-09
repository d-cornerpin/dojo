// t177 (Run 12 S1, variant A row 143838): after t173 a job's park continuation is the OWNER's turn again
// (kind user, root the owner's ask), and that ask is still open, so t172's "a person is waiting" read the
// continuation as a live turn and the job's narration ("Audit is at page 92…") reached the owner's chat.
// The owner was told once already (the acknowledgement) and is owed the result, nothing between: a run
// launched from a park's continuation keeps its working notes agent-only. The turn that RECEIVED the ask
// (no job carried yet) is unchanged.
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
const fakeDb = { prepare: () => emptyStmt, transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a) } as unknown as PostCallClassifyContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));
let carriesJob = false;
vi.mock('../../../../../work/task-freshness.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCarriesJob: () => carriesJob,
}));

import { INTERNAL_WORKING_NOTE_PREFIX, WORKING_NOTE_PREFIX } from '@dojo/shared';
import { initState, type AgentTurnState } from '../../../state.js';
import { runTerminalText } from '../terminal-text.js';
import type { PostCallClassifyContext, PostCallScratch } from '../index.js';

const AGENT = 'agent-t177';
const turnCtx = { agentId: AGENT, kind: 'user', convKey: 'owner', conversationId: 'conv-owner', root: { kind: 'ask', id: 'ask-1' },
  servedWork: undefined, deferredUserReplyWithTools: null, engineStartAckDeliveredThisTurn: false,
  deferredDeliveredByAck: false, startAckSteerArmedThisTurn: false };
function ctx(): PostCallClassifyContext {
  return {
    agentId: AGENT, turnCtx: turnCtx as unknown as PostCallClassifyContext['turnCtx'], turnNumber: 3, db: fakeDb,
    agent: { id: AGENT, name: 'Agent' } as unknown as PostCallClassifyContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as PostCallClassifyContext['counterparty'],
    counterpartyIsAgentSender: false, chosenConvKey: 'owner',
    hasUnansweredUser: true,   // the owner's ask is open: he is owed the result
    triggerRow: null, isA2ATurn: false, isEngineTurn: false, isHumanContinuation: false, mostRecentIsA2A: false,
    mostRecentInbound: undefined, pendingEngineEvent: null, unrepliedAssign: null, a2aReplyContext: null,
    a2aReplyAssignMessageId: null, settledContextWakeTurn: false, waitingConvs: [], inboundChannel: 'dashboard',
    latestUserSource: null, lastUserMessageContent: null, configuredModelId: 'floor', turnStartedAt: new Date().toISOString(),
    messageId: 'msg-1',
    result: { content: 'Audit is at page 92 of the chain and still walking it.',
      toolCalls: [{ id: 'tc1', name: 'file_read', input: { path: '/x/page-93.txt' } }] as ToolCall[],
      inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' } as unknown as PostCallClassifyContext['result'],
    maxToolLoops: 20, reArmIfStrandedNoAnswer: vi.fn(), noteTerminalAnswer: vi.fn(),
    deliverEngineUserAck: vi.fn(async () => undefined), persistAndBroadcastSystemRow: vi.fn(), startAckRepliedNow: () => false,
  } as unknown as PostCallClassifyContext;
}
const scratch = (): PostCallScratch => ({ persistedContent: null, interAgentTurn: false, deliberateSurfaceTurn: false,
  deliveredAsStartLine: false, hasXmlFallbackTools: false, effectiveModelIdForPersist: 'floor' });
const notes = () => insertMessageIfAbsentSpy.mock.calls.map((c) => c[0] as { role?: string; content: string }).filter((r) => r.role === 'system');

let state: AgentTurnState;
beforeEach(() => { broadcastSpy.mockClear(); insertMessageIfAbsentSpy.mockClear(); state = initState({ maxToolLoops: 20 } as Parameters<typeof initState>[0]); });

describe('t177: a resumed job keeps its working notes to itself', () => {
  it('a park continuation of the owner\'s open ask writes an AGENT-ONLY note', async () => {
    carriesJob = true;
    await runTerminalText(state, ctx(), scratch());
    expect(notes()).toHaveLength(1);
    expect(notes()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(true);
  });
  it('CONTROL: the turn that received the ask (no job carried yet) keeps today\'s visible note', async () => {
    carriesJob = false;
    await runTerminalText(state, ctx(), scratch());
    expect(notes()).toHaveLength(1);
    expect(notes()[0].content.startsWith(WORKING_NOTE_PREFIX)).toBe(true);
    expect(notes()[0].content.startsWith(INTERNAL_WORKING_NOTE_PREFIX)).toBe(false);
  });
});
