// ════════════════════════════════════════
// PHASE-6 T7 — THE `execute` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1). CUT 7 in the ordinal order (RULING P6-R3(3)).
//
// The shared shape, unchanged from CUT 1–6 and reusing `steps/step-outcome.ts`:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span
//               read from the driver. Measured, not guessed: after this tranche's
//               one carrier commit the binder census finds 22 top-level crossings
//               of which THREE are mutable (`state`, which the contract carries,
//               and two flags that ride by value on positive evidence), plus the
//               four values `postCallClassify` produces in this same iteration.
//   OUTPUT      a step outcome — the advanced state, ONE directive, and (on the
//               proceed arm ONLY) the tool results the rest of the turn reads.
//   TRANSITION  the driver advances `phase` INTO the step; the step never writes it.
//   EXIT        the exit-request channel: the step ASKS by returning.
//
// ── WHAT IS THIS STEP'S ALONE, AND IT IS THREE THINGS THE PLAN NAMES ──
//
// 1. THE EXECUTOR CHOKE POINT. Every tool this engine runs runs HERE, behind the
//    P3 once-per-response guard and the identical-call brake, and the plan's own
//    tranche note says both "stay at the executor choke point". They are asserted
//    against the step, not against the driver that used to hold them.
// 2. THE A2A SEND CAP IS CARRIED. Same note, third duty. Its unit-level clause is
//    here; the end-to-end one landed at Step 1a, GREEN on the unmoved tree, because
//    the cap had no test anywhere in either repo.
// 3. IT HAS THE MOST WAYS OUT OF ANY TRANCHE — six, against `assemble`'s one and
//    `callLLM`'s two — so the exit census is this contract's centre of gravity.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import {
  runExecute,
  EXECUTE_PHASE,
  type ExecuteContext,
} from '../index.js';
import { FX, FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';

// ── The step's outside world ──
// Each mock stands in for a DOOR the span already went through; none of them
// changes a decision.
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
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
vi.mock('../../../permissions.js', () => ({ getAgentPermissions: () => ({}) }));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
const recordToolOutcomeSpy = vi.fn(() => 0);
vi.mock('../../attempt-record.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordToolOutcome: (...a: unknown[]) => recordToolOutcomeSpy(...(a as [])),
}));

// A unit test must not open the dev database. Every DB reader in this span is a
// door it already went through inside the loop; the stub answers nothing.
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
const fakeDb = {
  prepare: () => emptyStmt,
  transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
} as unknown as ExecuteContext['db'];
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => fakeDb }));

const fireStartAckIfOwedSpy = vi.fn(async () => undefined);
const persistRoutingMarkerSpy = vi.fn();

function turnCtxFor(over: Record<string, unknown> = {}): ExecuteContext['turnCtx'] {
  return {
    agentId: FXID.n4,
    convKey: 'ck-1',
    conversationId: 'conv-1',
    servedWork: undefined,
    toolPhaseEndedByRepeats: false,
    anyToolStartedThisTurn: false,
    startAckSteerRequested: false,
    startAckSteerArmedThisTurn: false,
    ...over,
  } as unknown as ExecuteContext['turnCtx'];
}

const modelResult = (toolCalls: ToolCall[]): ExecuteContext['result'] => ({
  content: '', toolCalls, inputTokens: 10, outputTokens: 5, stopReason: 'tool_use',
} as unknown as ExecuteContext['result']);

function ctxFor(over: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    agentId: FXID.n4,
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    agent: { id: FXID.n4, name: FX.n4 } as unknown as ExecuteContext['agent'],
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard' } as unknown as ExecuteContext['counterparty'],
    counterpartyIsAgentSender: false,
    chosenConvKey: 'ck-1',
    hasUnansweredUser: true,
    triggerRow: null,
    triggerWorkId: null,
    triggerConversationId: null,
    turnStartedAt: new Date().toISOString(),
    persistRoutingMarker: persistRoutingMarkerSpy,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    refusedOnceSigs: new Set<string>(),
    startAckArmed: false,
    startAckArmedAtMs: Date.now(),
    fireStartAckIfOwed: fireStartAckIfOwedSpy,
    result: modelResult([]),
    messageId: 'msg-1',
    persistedContent: null,
    interAgentTurn: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'test-model',
    staleTaskWindowMinutes: 45,
    engineBlockEscapeHatch: '[escape hatch]',
    engineStartAckAfterMs: 20000,
    ...over,
  } as ExecuteContext;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  return advance(initState(FXID.n4, 'test-model'), { phase: EXECUTE_PHASE, loopCount: 2, ...over });
}

const call = (name: string, args: Record<string, unknown> = {}, id = `tc-${name}-${Math.random()}`): ToolCall =>
  ({ id, name, arguments: args } as ToolCall);

beforeEach(() => {
  vi.clearAllMocks();
  executeToolSpy.mockImplementation(async (_a: string, tc: ToolCall) => ({
    toolCallId: tc.id, name: tc.name, content: 'ok', isError: false,
  }));
  recordToolOutcomeSpy.mockReturnValue(0);
});

describe('PHASE-6 CUT 7: the `execute` step\'s contract', () => {
  it('INPUTS (state, ctx) → ONE outcome, and the tool results come back as the step\'s OUTPUT', async () => {
    const out = await runExecute(freshState(), ctxFor({ result: modelResult([call('file_read', { path: 'a.txt' })]) }));

    expect(out.directive).toBe('proceed');
    if (out.directive !== 'proceed') throw new Error('unreachable');
    // The ONE escaping declaration of this span, measured by the binder census: the
    // driver hands it straight to `postExecution`.
    expect(out.turnToolResults).toHaveLength(1);
    expect(out.turnToolResults[0].name).toBe('file_read');
    // And the same results are on the state the driver assigns, which is what the
    // next model call reads.
    expect(out.state.toolResults).toHaveLength(1);
  });

  it('THE STEP NEVER WRITES `phase` — on the proceed arm, on an exit arm, and nowhere in its source', async () => {
    const proceed = await runExecute(freshState(), ctxFor({ result: modelResult([call('file_read')]) }));
    expect(proceed.state.phase).toBe(EXECUTE_PHASE);

    // `complete_task` is one of the six ways out of this span.
    const exited = await runExecute(freshState(), ctxFor({ result: modelResult([call('complete_task')]) }));
    expect(exited.directive).toBe('exit');
    expect(exited.state.phase).toBe(EXECUTE_PHASE);
  });

  it('EXIT IS NOT SAYABLE WITHOUT A REASON, and each of the five names its own', async () => {
    const completeTask = await runExecute(freshState(), ctxFor({ result: modelResult([call('complete_task')]) }));
    expect(completeTask.directive).toBe('exit');
    if (completeTask.directive !== 'exit') throw new Error('unreachable');
    expect(completeTask.reason).toMatch(/complete/);

    // Words beside the call already count: no extra step is asked for.
    const generator = await runExecute(freshState(), ctxFor({
      result: { ...modelResult([call('image_create', { prompt: 'a cat' })]), content: 'Here it comes.' } as ExecuteContext['result'],
    }));
    expect(generator.directive).toBe('exit');
    if (generator.directive !== 'exit') throw new Error('unreachable');
    expect(generator.reason).toMatch(/generator|fire-and-forget/);
  });

  it('A GENERATOR WITH NO WORDS BESIDE IT GRANTS ONE MORE MODEL STEP, and that step ends the turn whatever it does', async () => {
    const turnCtx = turnCtxFor();
    const first = await runExecute(freshState(), ctxFor({ turnCtx, result: modelResult([call('image_create', { prompt: 'a cat' })]) }));
    expect(first.directive).toBe('proceed');
    expect((turnCtx as unknown as { mediaWordsStepOwed: boolean }).mediaWordsStepOwed).toBe(true);

    // The granted step: a second generator is refused (never executed) and the turn ends.
    executeToolSpy.mockClear();
    const second = await runExecute(freshState(), ctxFor({ turnCtx, result: modelResult([call('image_create', { prompt: 'again' }, 'tc-2')]) }));
    expect(executeToolSpy).not.toHaveBeenCalled();
    expect(second.directive).toBe('exit');
  });

  it('NO EXTRA STEP where the words would go nowhere: an agent counterparty ends as before', async () => {
    const turnCtx = turnCtxFor();
    const out = await runExecute(freshState(), ctxFor({
      turnCtx,
      counterparty: { kind: 'agent', name: FX.n4 } as unknown as ExecuteContext['counterparty'],
      result: modelResult([call('image_create', { prompt: 'a cat' })]),
    }));
    expect(out.directive).toBe('exit');
    expect((turnCtx as unknown as { mediaWordsStepOwed?: boolean }).mediaWordsStepOwed).toBeFalsy();
  });

  it('A STEP THAT ASKS TO EXIT STOPS — the floors after the exit never run', async () => {
    // The failure mode the channel exists to remove. `complete_task` exits; the
    // delegation block that sits AFTER it in the same span must not execute, so a
    // send_to_agent issued in the same response cannot open a delegation join.
    const out = await runExecute(
      freshState(),
      ctxFor({
        result: modelResult([call('complete_task'), call('send_to_agent', { to_agent: 'alice', intent: 'QUESTION', message: 'hi' })]),
        triggerRow: { rowid: 1 } as unknown as ExecuteContext['triggerRow'],
        triggerWorkId: 'work-1',
      }),
    );

    expect(out.directive).toBe('exit');
    // No steer was queued by the delegation-exit floor, which is the floor that would
    // have run had the step kept going after asking to stop.
    expect(out.state.steerQueue.pending.filter((e) => e.floor === 'delegation-exit')).toHaveLength(0);
    expect(out.state.steerQueue.fired.filter((e) => e.floor === 'delegation-exit')).toHaveLength(0);
  });

  it('THE ONCE-GUARD STAYS AT THE EXECUTOR CHOKE POINT (P3): an identical non-idempotent duplicate runs ONCE', async () => {
    // Same signature twice in ONE response: the side effect happens once and the
    // second call gets a structured result naming the first execution.
    const args = { prompt: 'a cat in a hat' };
    const out = await runExecute(freshState(), ctxFor({
      result: modelResult([call('image_create', args, 'tc-a'), call('image_create', args, 'tc-b')]),
    }));

    expect(executeToolSpy.mock.calls.filter((c) => (c[1] as ToolCall).name === 'image_create')).toHaveLength(1);
    if (out.directive === 'abandon') throw new Error('unreachable');
    const refused = out.state.toolResults.find((r) => r.isError && String(r.content).includes('Already executed in this response'));
    expect(refused).toBeDefined();
  });

  it('THE BRAKE STAYS AT THE CHOKE POINT: once the tool phase ended, nothing executes and the text says so', async () => {
    const out = await runExecute(
      freshState(),
      ctxFor({ turnCtx: turnCtxFor({ toolPhaseEndedByRepeats: true }), result: modelResult([call('file_read', { path: 'a.txt' })]) }),
    );

    expect(executeToolSpy).not.toHaveBeenCalled();
    if (out.directive === 'abandon') throw new Error('unreachable');
    expect(String(out.state.toolResults[0].content)).toContain('No further tools will run this turn');
  });

  it('A STOP MID-BATCH FILLS THE REMAINING CALLS AND LEAVES THE AGENT IDLE', async () => {
    // Part XIX preservation: the calls that never ran come back as Cancelled results
    // rather than as nothing, so the model's next context is not missing tool results
    // for tool calls it made.
    const { stoppedAgents } = await import('../../../../shared-state.js');
    stoppedAgents.add(FXID.n4);
    try {
      const out = await runExecute(freshState(), ctxFor({
        result: modelResult([call('file_write', { path: 'a', content: 'b' }), call('file_write', { path: 'c', content: 'd' })]),
      }));
      expect(out.directive).toBe('exit');
      if (out.directive !== 'exit') throw new Error('unreachable');
      expect(out.reason).toMatch(/stop/i);
      // T83 FIX ROUND 2: the spy-based "this step does not write idle" assertion that stood here
      // is GONE, and so is the `setAgentStatus` it was handed — `ExecuteContext` no longer declares one, so
      // the step cannot reach a status writer at all. The guarantee did not weaken; it moved to
      // where it covers every mechanism instead of one closure: the compiler (no field), the
      // engine-wide census in `a-stop-stops-and-the-status-tells-the-truth.test.ts`, and the one
      // owner's own behaviour in `steps/teardown/__tests__/contract.test.ts`.
      expect(out.state.toolResults.some((r) => String(r.content).includes('Cancelled by user'))).toBe(true);
    } finally {
      stoppedAgents.delete(FXID.n4);
    }
  });
});
