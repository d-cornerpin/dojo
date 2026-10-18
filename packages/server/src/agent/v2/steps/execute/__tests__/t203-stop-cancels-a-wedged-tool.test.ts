// ════════════════════════════════════════
// t203 (B6) — STOP ENDS A TURN WHOSE TOOL CALL IS STUCK.
//
// THE DEFECT, re-derived from the code at the base: `stopAgent` raises the fence and aborts
// what is in the abort registry. The executor reads the fence only BETWEEN calls and batches,
// and in between it does `await runOne(tc)` / `await Promise.all(batch.calls.map(runOne))`,
// and `runOne` awaits `executeTool` with no race of its own. A tool that registered nothing
// (a shell command, a hung child process, a send blocked somewhere) held the turn until it
// returned on its own; the owner's button did nothing he could see.
//
// THE OWNER'S RULING (v3.4 decision 5): the turn ends NOW, an action already in flight is
// cancelled where the service allows it, and the owner is told the outcome plainly.
//
// These clauses drive the REAL stop door (`stopAgent`) against the REAL executor step, with
// the tool door replaced by one that never answers.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { RepeatCallState } from '../../../identical-call-brake.js';
import { runExecute, EXECUTE_PHASE, type ExecuteContext, type ExecuteOutcome } from '../index.js';

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
const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (ev: Record<string, unknown>) => { broadcasts.push(ev); } }));
vi.mock('../../../permissions.js', () => ({ getAgentPermissions: () => ({}) }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
const recordToolOutcomeSpy = vi.fn(() => 0);
vi.mock('../../attempt-record.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordToolOutcome: (...a: unknown[]) => recordToolOutcomeSpy(...(a as [])),
}));
// Importing the stop door must not pull the turn driver (it has a module-init cycle).
vi.mock('../../../loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  exec: () => undefined,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as ExecuteContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const AGENT = 't203-agent';

function ctxFor(toolCalls: ToolCall[]): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: {
      agentId: AGENT, convKey: 'ck-1', conversationId: 'conv-1', servedWork: undefined,
      toolPhaseEndedBySpinBrake: false, anyToolStartedThisTurn: false,
      startAckSteerRequested: false, startAckSteerArmedThisTurn: false,
    } as unknown as ExecuteContext['turnCtx'],
    turnNumber: 7,
    db: fakeDb,
    agent: { id: AGENT, name: null } as unknown as ExecuteContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as ExecuteContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    triggerWorkId: null,
    triggerConversationId: null,
    turnStartedAt: new Date().toISOString(),
    persistRoutingMarker: vi.fn(),
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    identicalCallState: new Map() as RepeatCallState,
    reminderLaneRefusedSigs: new Set<string>(),
    startAckArmed: false,
    startAckArmedAtMs: Date.now(),
    fireStartAckIfOwed: vi.fn(async () => undefined),
    result: { content: '', toolCalls, inputTokens: 10, outputTokens: 5, stopReason: 'tool_use' } as unknown as ExecuteContext['result'],
    messageId: 'msg-1',
    persistedContent: null,
    interAgentTurn: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'test-model',
    staleTaskWindowMinutes: 45,
    maxToolLoops: 75,
    engineBlockEscapeHatch: '[escape hatch]',
    engineStartAckAfterMs: 20000,
  } as ExecuteContext;
}

const freshState = (): AgentTurnState =>
  advance(initState(AGENT, 'test-model'), { phase: EXECUTE_PHASE, loopCount: 2 });

const call = (name: string, args: Record<string, unknown> = {}, id = `tc-${name}-${Math.random()}`): ToolCall =>
  ({ id, name, arguments: args } as ToolCall);

/** A tool that never answers. The settle handle lets a clause finish it LATE, after the stop. */
function wedged(): { promise: Promise<unknown>; settle: (r: unknown) => void } {
  let settle!: (r: unknown) => void;
  const promise = new Promise<unknown>((r) => { settle = r; });
  return { promise, settle };
}

const TOO_LONG = Symbol('the turn did not end');
/** The turn, or TOO_LONG if it is still holding after a wait the owner would call "now". */
async function within(ms: number, p: Promise<ExecuteOutcome>): Promise<ExecuteOutcome | typeof TOO_LONG> {
  return Promise.race([p, new Promise<typeof TOO_LONG>((r) => setTimeout(() => r(TOO_LONG), ms))]);
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pressStop(): Promise<void> {
  const shared = await import('../../../../shared-state.js');
  shared.activeRuns.add(AGENT); // a run is in flight: the stop raises the run's fence
  const { stopAgent } = await import('../../../../runtime.js');
  stopAgent(AGENT);
}

beforeEach(() => {
  vi.clearAllMocks();
  broadcasts.length = 0;
  recordToolOutcomeSpy.mockReturnValue(0);
});

afterEach(async () => {
  const s = await import('../../../../shared-state.js');
  s.stoppedAgents.clear();
  s.stopFencedRuns.clear();
  s.activeRuns.clear();
  s.pendingWakeups.clear();
  s.activeAbortControllers.clear();
});

describe('t203: Stop ends a turn whose tool call is stuck', () => {
  it('THE RED: a tool that never answers — Stop ends the turn now, Cancelled, and the turn says the owner stopped it', async () => {
    const hang = wedged();
    executeToolSpy.mockImplementation(() => hang.promise);
    const tc = call('shell', { script: 'sleep 600' });

    const turn = runExecute(freshState(), ctxFor([tc]));
    await tick();
    await pressStop();

    const out = await within(1500, turn);
    expect(out, 'the turn is still holding on the stuck tool after Stop').not.toBe(TOO_LONG);
    const o = out as ExecuteOutcome;
    expect(o.directive).toBe('exit');
    expect((o as { reason: string }).reason).toBe('stopped-mid-batch');
    // WHO ENDED IT: the turn record's engine-cut latch names the stop.
    expect(o.state.engineCutExit).toBe('stop');
    const slot = o.state.toolResults.find((r) => r.toolCallId === tc.id);
    expect(slot?.isError).toBe(true);
    expect(slot?.content).toMatch(/^Cancelled by user \(agent stopped\)/);
    // The dashboard's tool card is closed, not left spinning.
    expect(broadcasts.some((b) => b.type === 'chat:tool_result' && b.tool === 'shell'
      && String(b.result).startsWith('Cancelled by user'))).toBe(true);
  });

  it('a parallel batch with one stuck call and one finished call: the finished result is KEPT', async () => {
    const hang = wedged();
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) =>
      tc.name === 'web_search' ? hang.promise : { toolCallId: tc.id, name: tc.name, content: 'file body', isError: false });
    const done = call('file_read', { path: 'a.txt' });
    const stuck = call('web_search', { query: 'q' });

    const turn = runExecute(freshState(), ctxFor([done, stuck]));
    await tick();
    await pressStop();

    const out = await within(1500, turn);
    expect(out).not.toBe(TOO_LONG);
    const o = out as ExecuteOutcome;
    expect(o.directive).toBe('exit');
    const kept = o.state.toolResults.find((r) => r.toolCallId === done.id);
    expect(kept?.content).toContain('file body');
    expect(kept?.isError).toBe(false);
    const cut = o.state.toolResults.find((r) => r.toolCallId === stuck.id);
    expect(cut?.content).toMatch(/^Cancelled by user \(agent stopped\)/);
  });

  it('the abandoned call\'s LATE result is never applied to the turn, and records no success', async () => {
    const hang = wedged();
    executeToolSpy.mockImplementation(() => hang.promise);
    const tc = call('file_write', { path: 'x.txt', content: 'y' });

    const turn = runExecute(freshState(), ctxFor([tc]));
    await tick();
    await pressStop();
    const o = (await within(1500, turn)) as ExecuteOutcome;
    expect(o).not.toBe(TOO_LONG);

    hang.settle({ toolCallId: tc.id, name: tc.name, content: 'written', isError: false });
    await tick();
    const slot = o.state.toolResults.filter((r) => r.toolCallId === tc.id);
    expect(slot).toHaveLength(1);
    expect(slot[0].content).not.toContain('written');
    // The cross-turn attempt record is not told about a call the owner cut: neither a success
    // nor a "this keeps failing" failure.
    expect(recordToolOutcomeSpy).not.toHaveBeenCalled();
  });

  it('a SEND the stop could not recall: the slot says it may already have gone, and the owner is told the real outcome when it lands', async () => {
    const hang = wedged();
    executeToolSpy.mockImplementation(() => hang.promise);
    const tc = call('gmail_send', { to: 'someone@example.com', subject: 's', body: 'b' });

    const turn = runExecute(freshState(), ctxFor([tc]));
    await tick();
    await pressStop();
    const o = (await within(1500, turn)) as ExecuteOutcome;
    expect(o).not.toBe(TOO_LONG);
    const slot = o.state.toolResults.find((r) => r.toolCallId === tc.id);
    expect(slot?.content).toMatch(/^Cancelled by user \(agent stopped\)/);
    // The model must not read "cancelled" as "it did not happen" and send it again blind.
    expect(slot?.content).toMatch(/may already have/i);

    // The provider accepted it after all: the owner hears it in plain words.
    hang.settle({ toolCallId: tc.id, name: tc.name, content: 'Email sent (id abc).', isError: false });
    await tick();
    const told = broadcasts.find((b) => b.type === 'chat:error' && b.agentId === AGENT);
    expect(told, 'the owner was not told the send went out after Stop').toBeDefined();
    expect(String(told!.error)).toMatch(/email had already been sent/i);
    expect(told!.severity).toBe('warning');
  });

  it('a send the stop DID cut: the owner is told it did not go out', async () => {
    const hang = wedged();
    executeToolSpy.mockImplementation(() => hang.promise);
    const tc = call('sms_send', { to: '+15550000000', body: 'b' });

    const turn = runExecute(freshState(), ctxFor([tc]));
    await tick();
    await pressStop();
    await within(1500, turn);

    hang.settle({ toolCallId: tc.id, name: tc.name, content: 'Error: Twilio network error: aborted', isError: true });
    await tick();
    const told = broadcasts.find((b) => b.type === 'chat:error' && b.agentId === AGENT);
    expect(told).toBeDefined();
    expect(String(told!.error)).toMatch(/text message/i);
    expect(String(told!.error)).toMatch(/not sent|did not go out|could not confirm/i);
  });

  it('a stop already standing when the call is reached: the tool is never started', async () => {
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) =>
      ({ toolCallId: tc.id, name: tc.name, content: 'ran', isError: false }));
    const shared = await import('../../../../shared-state.js');
    shared.stoppedAgents.add(AGENT);
    const out = await runExecute(freshState(), ctxFor([call('shell', { script: 'echo hi' })]));
    expect(out.directive).toBe('exit');
    expect(executeToolSpy).not.toHaveBeenCalled();
  });

  it('a tool that finishes normally with no stop is untouched (no race artefacts)', async () => {
    executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) =>
      ({ toolCallId: tc.id, name: tc.name, content: 'ok', isError: false }));
    const out = await runExecute(freshState(), ctxFor([call('file_read', { path: 'a.txt' })]));
    expect(out.directive).toBe('proceed');
    expect(out.state.engineCutExit).toBeNull();
    const { stopWaiterCount } = await import('../../../../stop-waiters.js');
    expect(stopWaiterCount(AGENT)).toBe(0);
  });
});
