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
//
// ── AND ONE LANDMINE, WRITTEN DOWN SO IT CANNOT BE TIDIED AWAY ──
// `identicalCallSignature` (the brake's) and `canonicalToolSignature` (the thrash
// gate's / the cross-turn record's) STAY DISTINCT — Global Constraints names
// unifying them as a documented landmine, because one edit would silently move two
// different thresholds. Both live in this span; a clause below pins them apart.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { RepeatCallState } from '../../../identical-call-brake.js';
import {
  runExecute,
  EXECUTE_PHASE,
  type ExecuteContext,
} from '../index.js';

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

const setAgentStatusSpy = vi.fn();
const fireStartAckIfOwedSpy = vi.fn(async () => undefined);
const persistRoutingMarkerSpy = vi.fn();

function turnCtxFor(over: Record<string, unknown> = {}): ExecuteContext['turnCtx'] {
  return {
    agentId: 'kevin',
    convKey: 'ck-1',
    conversationId: 'conv-1',
    servedWork: undefined,
    toolPhaseEndedBySpinBrake: false,
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
    agentId: 'kevin',
    turnCtx: turnCtxFor(),
    turnNumber: 7,
    db: fakeDb,
    agent: { id: 'kevin', name: 'Kevin' } as unknown as ExecuteContext['agent'],
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
    identicalCallState: new Map() as RepeatCallState,
    reminderLaneRefusedSigs: new Set<string>(),
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
    maxToolLoops: 75,
    engineBlockEscapeHatch: '[escape hatch]',
    engineStartAckAfterMs: 20000,
    setAgentStatus: setAgentStatusSpy,
    ...over,
  } as ExecuteContext;
}

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  return advance(initState('kevin', 'test-model'), { phase: EXECUTE_PHASE, loopCount: 2, ...over });
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

// ── The step package's own source, for the clauses that are about SHAPE ──
const STEP_DIR = path.resolve(__dirname, '..');
function stepFiles(dir: string = STEP_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...stepFiles(path.join(dir, e.name))); }
    else if (e.name.endsWith('.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}
const stepText = (): string => stepFiles().map((f) => readFileSync(f, 'utf8')).join('\n');

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

    // And no `phase:` write exists in the package's own source at all.
    expect(stepText()).not.toMatch(/phase\s*:/);
  });

  it('THE DRIVER ADVANCES INTO IT, at the call site and ahead of the step', () => {
    // `validate()` runs on the transition by construction, because the advance is an
    // `advance` and it is the DRIVER's statement, not the step's.
    const driver = readFileSync(path.resolve(__dirname, '../../../loop.ts'), 'utf8');
    const advanceAt = driver.indexOf("advance(turnCtx.state!, { phase: 'execute' })");
    const callAt = driver.indexOf('runExecute(turnCtx.state!,');
    expect(advanceAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(advanceAt).toBeLessThan(callAt);
  });

  it('THE EXIT-REQUEST CHANNEL, as a CENSUS WITH A DENOMINATOR: three directives, FIVE exits, ONE continue', () => {
    // This span has the MOST ways out of any tranche and every one of them was a
    // `break` or a `continue` of the driver's loop. A new silent way out cannot appear
    // without failing here. The walk is over the package's own AST, so a directive
    // named in a comment does not count and a real call does.
    const directives = new Set<string>();
    let exitSites = 0;
    let continueSites = 0;
    for (const f of stepFiles()) {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ESNext, true);
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const name = n.expression.text;
          if (name === 'proceed') directives.add('proceed');
          if (name === 'continueLoop') { directives.add('continue'); continueSites += 1; }
          if (name === 'requestExit') { directives.add('exit'); exitSites += 1; }
          if (name === 'abandonTurn') directives.add('abandon');
        }
        ts.forEachChild(n, walk);
      };
      walk(sf);
    }
    expect([...directives].sort()).toEqual(['continue', 'exit', 'proceed']);
    // The five: stopped mid-batch · complete_task · fire-and-forget generator ·
    // the A2A reply that IS the response · the delegation hand-off's async exit.
    expect(exitSites).toBe(5);
    // The one: the delegation-exit steer, which asks for another iteration so the
    // model can say one line to the person before the turn ends.
    expect(continueSites).toBe(1);
  });

  it('EXIT IS NOT SAYABLE WITHOUT A REASON, and each of the five names its own', async () => {
    const completeTask = await runExecute(freshState(), ctxFor({ result: modelResult([call('complete_task')]) }));
    expect(completeTask.directive).toBe('exit');
    if (completeTask.directive !== 'exit') throw new Error('unreachable');
    expect(completeTask.reason).toMatch(/complete/);

    const generator = await runExecute(freshState(), ctxFor({ result: modelResult([call('image_create', { prompt: 'a cat' })]) }));
    expect(generator.directive).toBe('exit');
    if (generator.directive !== 'exit') throw new Error('unreachable');
    expect(generator.reason).toMatch(/generator|fire-and-forget/);
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
      ctxFor({ turnCtx: turnCtxFor({ toolPhaseEndedBySpinBrake: true }), result: modelResult([call('file_read', { path: 'a.txt' })]) }),
    );

    expect(executeToolSpy).not.toHaveBeenCalled();
    if (out.directive === 'abandon') throw new Error('unreachable');
    expect(String(out.state.toolResults[0].content)).toContain('No further tools will run this turn');
  });

  it('THE A2A SEND CAP IS CARRIED, at its verbatim value: the sixth send to one recipient is refused', async () => {
    const sends = [1, 2, 3, 4, 5, 6].map((n) =>
      call('send_to_agent', { to_agent: 'alice', message: `ask number ${n}` }, `tc-${n}`));
    const out = await runExecute(freshState(), ctxFor({ result: modelResult(sends) }));

    expect(executeToolSpy.mock.calls.filter((c) => (c[1] as ToolCall).name === 'send_to_agent')).toHaveLength(5);
    if (out.directive === 'abandon') throw new Error('unreachable');
    const refusals = out.state.toolResults.filter((r) => String(r.content).includes('already sent'));
    expect(refusals).toHaveLength(1);
    expect(String(refusals[0].content)).toContain('5 messages this turn');
  });

  it('THE TWO SIGNATURE FUNCTIONS STAY DISTINCT — the documented landmine, pinned in the package that holds both', () => {
    // Global Constraints: unifying them silently changes two different thresholds.
    // Both are used in this span; the census refuses a package where one has been
    // rewritten in terms of the other.
    const src = stepText();
    expect(src).toMatch(/identicalCallSignature\(/);
    expect(src).toMatch(/canonicalToolSignature\(/);
    const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.ESNext, true);
    const names = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.add(n.expression.text);
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect(names.has('identicalCallSignature')).toBe(true);
    expect(names.has('canonicalToolSignature')).toBe(true);
  });

  it('EVERY THRESHOLD IN THIS SPAN IS COPIED VERBATIM', () => {
    // Global Constraints: "bounds and thresholds are copied verbatim". These are the
    // ones this span declares; the rest arrive on the context or from their own module.
    const src = stepText();
    expect(src).toMatch(/A2A_SEND_CAP_PER_RECIPIENT\s*=\s*5\b/);
    expect(src).toMatch(/TRACKER_NUDGE_THRESHOLD\s*=\s*3\b/);
    expect(src).toMatch(/TRACKER_AUTO_SCAFFOLD_AT\s*=\s*6\b/);
  });

  it('A STOP MID-BATCH FILLS THE REMAINING CALLS AND LEAVES THE AGENT IDLE', async () => {
    // Part XIX preservation: the calls that never ran come back as Cancelled results
    // rather than as nothing, so the model's next context is not missing tool results
    // for tool calls it made.
    const { stoppedAgents } = await import('../../../../shared-state.js');
    stoppedAgents.add('kevin');
    try {
      const out = await runExecute(freshState(), ctxFor({
        result: modelResult([call('file_write', { path: 'a', content: 'b' }), call('file_write', { path: 'c', content: 'd' })]),
      }));
      expect(out.directive).toBe('exit');
      if (out.directive !== 'exit') throw new Error('unreachable');
      expect(out.reason).toMatch(/stop/i);
      expect(setAgentStatusSpy).toHaveBeenCalledWith('kevin', 'idle');
      expect(out.state.toolResults.some((r) => String(r.content).includes('Cancelled by user'))).toBe(true);
    } finally {
      stoppedAgents.delete('kevin');
    }
  });
});
