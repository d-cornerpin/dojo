// v3.5 field fix 3, ranked fix #7: A REFUSED send_to_agent DOES NOT END THE A2A TURN.
//
// The exit reads the calls that EXECUTED, never the model's emitted calls: a refused send does not
// end the turn as if it had gone out.
//
// The runaway-send guard stays: a send that actually EXECUTED still ends the turn at once.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runExecute, EXECUTE_PHASE, type ExecuteContext } from '../index.js';

const executeToolSpy = vi.fn();
vi.mock('../../../../tools/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../tools/index.js')>('../../../../tools/index.js');
  const { classifyToolResult } = await vi.importActual<typeof import('../../../../tool-outcome.js')>('../../../../tool-outcome.js');
  return {
    ...actual,
    executeTool: async (...a: unknown[]) => classifyToolResult(await executeToolSpy(...(a as []))),
    getFilteredTools: () => [],
  };
});
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../permissions.js', () => ({ getAgentPermissions: () => ({}) }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
vi.mock('../../attempt-record.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordToolOutcome: () => 0,
}));

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  exec: () => undefined,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as ExecuteContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const AGENT = 'agent-primary-a2a';

function ctxFor(toolCalls: ToolCall[], toolPhaseEnded = false): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, convKey: 'ck-a2a', conversationId: 'conv-a2a', servedWork: undefined,
      toolPhaseEndedByRepeats: toolPhaseEnded, anyToolStartedThisTurn: false,
      startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
    } as unknown as ExecuteContext['turnCtx'],
    turnNumber: 6560,
    db: fakeDb,
    agent: { id: AGENT, name: null } as unknown as ExecuteContext['agent'],
    // An A2A turn: the PM asked the primary something.
    counterparty: { kind: 'agent', name: 'pm' } as unknown as ExecuteContext['counterparty'],
    counterpartyIsAgentSender: true,
    chosenConvKey: 'ck-a2a',
    hasUnansweredUser: false,
    triggerRow: null,
    triggerWorkId: null,
    triggerConversationId: null,
    turnStartedAt: new Date().toISOString(),
    persistRoutingMarker: vi.fn(),
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    refusedOnceSigs: new Set<string>(),
    startAckArmed: false,
    startAckArmedAtMs: Date.now(),
    fireStartAckIfOwed: vi.fn(async () => undefined),
    result: { content: '', toolCalls, inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' } as unknown as ExecuteContext['result'],
    messageId: 'msg-a2a',
    persistedContent: null,
    interAgentTurn: true,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'test-model',
    staleTaskWindowMinutes: 45,
    engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 20000,
  } as ExecuteContext;
}

const stateWith = (over: Partial<AgentTurnState> = {}): AgentTurnState =>
  advance(initState(AGENT, 'test-model'), { phase: EXECUTE_PHASE, loopCount: 2, ...over });

const send = (id = 'tc-send'): ToolCall =>
  ({ id, name: 'send_to_agent', arguments: { to_agent: 'pm', intent: 'INFO', message: 'steps 2-4 are done' } } as ToolCall);

const sendsExecuted = (): number =>
  executeToolSpy.mock.calls.filter((c) => (c[1] as ToolCall).name === 'send_to_agent').length;

beforeEach(() => {
  vi.clearAllMocks();
  executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => ({
    toolCallId: tc.id, name: tc.name, content: 'sent', isError: false,
  }));
});

describe('fix #7: only an executed send ends the A2A turn', () => {

  it('a send refused because the tool phase ended does not end the turn either', async () => {
    const out = await runExecute(stateWith(), ctxFor([send()], true));
    expect(sendsExecuted()).toBe(0);
    expect(out.directive).not.toBe('exit');
  });

  it('RUNAWAY GUARD KEPT: a send that executed ends the turn at once', async () => {
    const out = await runExecute(stateWith(), ctxFor([send()]));
    expect(sendsExecuted()).toBe(1);
    expect(out.directive).toBe('exit');
    if (out.directive !== 'exit') throw new Error('unreachable');
    expect(out.reason).toBe('a2a-reply-sent');
  });

  it('a tracker call and an executed send in one response: the tracker call runs and the send still ends the turn', async () => {
    const tracker = { id: 'tc-note', name: 'work_note', arguments: { task_id: '8e877863-aaaa', notes: 'continuing' } } as ToolCall;
    const out = await runExecute(stateWith(), ctxFor([tracker, send()]));
    expect(sendsExecuted()).toBe(1);
    expect(out.directive).toBe('exit');
  });
});
