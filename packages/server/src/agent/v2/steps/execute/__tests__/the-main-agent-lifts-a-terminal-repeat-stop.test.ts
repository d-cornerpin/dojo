// At the terminal rung of the repeat rule the tool phase has ended, yet the main agent can still lift
// the stop: its continue_repeating runs with its reason, and the stopped call runs next. A helper cannot.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runExecute, EXECUTE_PHASE, type ExecuteContext } from '../index.js';
import { liftRepeatStops, noteRepeatResult, repeatStopRefusal } from '../../../identical-call-brake.js';

const MAIN = 'agent-main';
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
vi.mock('../../../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../../../config/platform.js')>()),
  isPrimaryAgent: (id: string) => id === MAIN,
}));
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



function ctxFor(agentId: string, turnCtx: Record<string, unknown>, toolCalls: ToolCall[]): ExecuteContext {
  return {
    agentId,
    turnCtx: turnCtx as unknown as ExecuteContext['turnCtx'],
    turnNumber: 6560,
    db: fakeDb,
    agent: { id: agentId, name: null } as unknown as ExecuteContext['agent'],
    counterparty: { kind: 'user' } as unknown as ExecuteContext['counterparty'],
    counterpartyIsAgentSender: false,
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
    interAgentTurn: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'test-model',
    staleTaskWindowMinutes: 45,
    engineBlockEscapeHatch: '',
    engineStartAckAfterMs: 20000,
  } as ExecuteContext;
}

const stateFor = (agentId: string): AgentTurnState => advance(initState(agentId, 'test-model'), { phase: EXECUTE_PHASE, loopCount: 2 });

const read = { id: 'tc-read', name: 'file_read', arguments: { path: '/tmp/example/notes.txt' } } as ToolCall;
const lift = { id: 'tc-lift', name: 'continue_repeating', arguments: { reason: 'the file is being written, I am watching it grow' } } as ToolCall;

/** A turn whose file_read was stopped and then refused until the tool phase ended. */
function terminalTurn(agentId: string): Record<string, unknown> {
  const turnCtx = {
    agentId, convKey: 'ck', conversationId: 'conv', servedWork: undefined, toolPhaseEndedBySpinBrake: true,
    anyToolStartedThisTurn: false, startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
  };
  for (let i = 0; i < 4; i++) noteRepeatResult(agentId, turnCtx as never, read.name, read.arguments, 'same', true);
  for (let i = 0; i < 3; i++) repeatStopRefusal(agentId, turnCtx as never, read.name, read.arguments);
  return turnCtx;
}

const ran = (name: string): number => executeToolSpy.mock.calls.filter((c) => (c[1] as ToolCall).name === name).length;

beforeEach(() => {
  vi.clearAllMocks();
  executeToolSpy.mockImplementation(async (agentId: string, tc: ToolCall) => tc.name === 'continue_repeating'
    ? { toolCallId: tc.id, name: tc.name, ...liftRepeatStops(agentId, (tc.arguments as { reason: string }).reason) }
    : { toolCallId: tc.id, name: tc.name, content: 'a new line', isError: false });
});

describe('the main agent lifts a terminal repeat stop', () => {
  it('its continue_repeating runs with the reason, and the stopped call runs next', async () => {
    const turnCtx = terminalTurn(MAIN);
    await runExecute(stateFor(MAIN), ctxFor(MAIN, turnCtx, [lift, read]));
    expect(ran('continue_repeating')).toBe(1);
    expect(ran('file_read')).toBe(1);
    expect(turnCtx.toolPhaseEndedBySpinBrake).toBe(false);
  });

  it('a helper at the terminal rung is still refused', async () => {
    const helper = 'agent-helper';
    await runExecute(stateFor(helper), ctxFor(helper, terminalTurn(helper), [lift, read]));
    expect(ran('continue_repeating') + ran('file_read')).toBe(0);
  });
});
