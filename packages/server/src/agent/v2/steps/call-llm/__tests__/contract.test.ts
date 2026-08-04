// ════════════════════════════════════════
// PHASE-6 T5 — THE `callLLM` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1). CUT 5 in the ordinal order (RULING P6-R3(3)).
//
// The shared shape, unchanged from CUT 1–4 and reusing `steps/step-outcome.ts`:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span
//               read from the driver. Measured, not guessed: after this tranche's
//               three carrier commits, 18 declarations of `runV2TurnBody` cross
//               into the span and TWO of them are mutable (`state`, which the
//               contract carries, and `chosenConversationId`, which dissolves
//               into the bag's own `conversationId` — CUT 4's refusal, re-derived).
//   OUTPUT      a step outcome — the advanced state, ONE directive, and (on the
//               proceed arm ONLY) the two values the span DECLARES and the rest
//               of the turn reads.
//   TRANSITION  the driver advances `phase` INTO the step; the step never writes it.
//   EXIT        the exit-request channel: the step ASKS by returning.
//
// ── WHAT IS THIS STEP'S ALONE, AND IT IS TWO THINGS ──
//
// 1. IT IS THE FIRST TRANCHE WITH ESCAPING DECLARATIONS. Every cut so far declared
//    nothing the rest of the body reads (0 escaping). This span declares TWO —
//    the message id it mints and the model result it obtains — read at 75 hit
//    lines across `postCallClassify` and `execute`. A module cannot leave a
//    declaration behind for its caller, so they are OUTPUTS, carried on the
//    proceed arm where the type makes them unreachable on any other.
//
// 2. IT IS THE ONLY SPAN THAT CAN ABANDON THE TURN. The other tranches leave
//    their loop with `break` (finalize still runs) or `continue`. This one holds
//    the two mid-call `return`s — the user pressed stop, or a peer preempted —
//    which skip finalize entirely and run only the `finally`. CUT 4's finalize
//    contract already pinned them from the driver's side, at exactly two, as
//    "the exits that genuinely bypass it". A module cannot `return` from its
//    caller, so the shared vocabulary gains a FOURTH directive rather than this
//    step inventing a private one: `abandon`, carrying its reason like `exit`.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { stoppedAgents, preemptedAgents } from '../../../../shared-state.js';
import { engineText } from '../../../__tests__/engine-sources.js';
import {
  runCallLLM,
  CALL_LLM_PHASE,
  type CallLLMContext,
} from '../index.js';

// ── The step's outside world ──
// Each mock stands in for a DOOR the span already went through; none of them
// changes a decision.
const callModelSpy = vi.fn();
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
}));
const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));
// A unit test must not open the dev database. Every DB READER this span goes
// through is a door it already went through inside the loop; none of them changes
// a decision, and the stub keeps them honest by answering nothing.
const emptyStmt = { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => emptyStmt }) }));
vi.mock('../../../outbound-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../outbound-ledger.js')>()),
  getRecentOutbound: () => [],
}));
vi.mock('../../../../../memory/deliveries-lane.js', () => ({ renderDeliveriesLaneMessage: () => null }));
vi.mock('../../../../../work/obligations.js', () => ({ buildOpenWorkInjection: () => null }));
vi.mock('../../../receipt.js', () => ({ writeContextReceipt: () => undefined }));
vi.mock('../../../../runtime.js', () => ({ enforceModelCapabilities: async () => ({ useTools: true }) }));
// The router is a DOOR too. The auto-routed arms exist to count ATTEMPTS, not to
// re-test tier selection, so the selector answers with one model and no fallbacks.
vi.mock('../../../../../router/decide.js', () => ({ decideTier: () => ({ tier: 'standard', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 0 }) }));
vi.mock('../../../../../router/selector.js', () => ({
  selectModel: () => ({ modelId: 'test-model', tier: 'standard' }),
  logRouterDecision: () => undefined,
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));

const setAgentStatusSpy = vi.fn();
const revertTriggerStampOnAbortSpy = vi.fn();

function ctxFor(overrides: Partial<CallLLMContext> = {}): CallLLMContext {
  return {
    agentId: 'kevin',
    turnCtx: { agentId: 'kevin', conversationId: 'conv-1', modelCallInFlight: false } as CallLLMContext['turnCtx'],
    turnNumber: 7,
    db: null as unknown as CallLLMContext['db'],
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false,
    isAutoRouted: false,
    configuredModelId: 'test-model',
    lastUserMessageContent: 'hello',
    messages: [{ role: 'user', content: 'hello' }] as unknown as CallLLMContext['messages'],
    systemPrompt: 'you are kevin',
    assembled: {
      systemEntryIds: [], messageEntryIds: [], allocation: null, freshTailDropped: 0,
      systemVolatile: '', reserveTokens: 0,
    } as unknown as CallLLMContext['assembled'],
    modelContext: {} as unknown as CallLLMContext['modelContext'],
    volatileFrom: undefined,
    steerAwaitingConfirm: null,
    revertTriggerStampOnAbort: revertTriggerStampOnAbortSpy,
    setAgentStatus: setAgentStatusSpy,
    ...overrides,
  };
}

function freshState(): AgentTurnState {
  return advance(initState('kevin', 'test-model'), { phase: CALL_LLM_PHASE, loopCount: 1 });
}

const OK_RESULT = {
  content: 'here you go', toolCalls: [], inputTokens: 10, outputTokens: 3, stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();
  stoppedAgents.clear();
  preemptedAgents.clear();
  callModelSpy.mockResolvedValue(OK_RESULT);
});

// ── The engine's own source, for the clauses that are about SHAPE ──
const STEP_DIR = path.resolve(__dirname, '..');
function stepText(): string {
  const files = ['index.ts'];
  const dir = readFileSync;   // keep the import used even if the list grows
  void dir;
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...walk(path.join(d, e.name))); }
      else if (e.name.endsWith('.ts')) out.push(path.join(d, e.name));
    }
    return out;
  };
  void files;
  return walk(STEP_DIR).map((f) => readFileSync(f, 'utf8')).join('\n');
}

describe('PHASE-6 CUT 5: the `callLLM` step\'s contract', () => {
  it('INPUTS (state, ctx) → ONE outcome, and the two values the span declares come back as OUTPUTS', async () => {
    const out = await runCallLLM(freshState(), ctxFor());

    expect(out.directive).toBe('proceed');
    if (out.directive !== 'proceed') throw new Error('unreachable');
    // The state came back advanced — the driver assigns it before honouring anything.
    expect(out.state.currentMessageId).toBe(out.messageId);
    expect(out.messageId).toMatch(/[0-9a-f-]{36}/);
    expect(out.result).toBe(OK_RESULT);
  });

  it('THE STEP NEVER WRITES `phase` — on the proceed arm and on both abandon arms', async () => {
    const proceed = await runCallLLM(freshState(), ctxFor());
    expect(proceed.state.phase).toBe(CALL_LLM_PHASE);

    stoppedAgents.add('kevin');
    callModelSpy.mockRejectedValue(new Error('aborted'));
    const stopped = await runCallLLM(freshState(), ctxFor());
    expect(stopped.state.phase).toBe(CALL_LLM_PHASE);

    preemptedAgents.add('kevin');
    const preempted = await runCallLLM(freshState(), ctxFor());
    expect(preempted.state.phase).toBe(CALL_LLM_PHASE);

    // And no `phase:` write exists in the step's own source at all.
    expect(stepText()).not.toMatch(/phase\s*:/);
  });

  it('THE DRIVER ADVANCES INTO IT, at the call site and ahead of the step', () => {
    // `validate()` runs on the transition by construction, because the advance is an
    // `advance` and it is the driver's statement, not the step's.
    const driver = readFileSync(path.resolve(__dirname, '../../../loop.ts'), 'utf8');
    const advanceAt = driver.indexOf("advance(state, { phase: 'callLLM' })");
    const callAt = driver.indexOf('runCallLLM(state,');
    expect(advanceAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(advanceAt);
  });

  it('THE EXIT-REQUEST CHANNEL, AS A CENSUS WITH A DENOMINATOR: two ways out, and exactly two abandons', () => {
    // A step that grows a third way out has to come through this clause. The
    // `abandon` sites are pinned at TWO because CUT 4's finalize contract pins the
    // same two exits from the driver's side ("the exits that genuinely bypass it").
    const src = stepText();
    const sf = ts.createSourceFile('step.ts', src, ts.ScriptTarget.ES2022, true);
    const directives = new Set<string>();
    let abandons = 0;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const fn = n.expression.text;
        if (fn === 'proceed' || fn === 'continueLoop' || fn === 'requestExit' || fn === 'abandonTurn') directives.add(fn);
        if (fn === 'abandonTurn') abandons += 1;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    expect([...directives].sort()).toEqual(['abandonTurn', 'proceed']);
    expect(abandons).toBe(2);
  });

  it('ABANDON, STOPPED: the flag is consumed, the agent goes idle, and the turn is asked to end', async () => {
    stoppedAgents.add('kevin');
    callModelSpy.mockRejectedValue(new Error('aborted mid-stream'));

    const out = await runCallLLM(freshState(), ctxFor());

    expect(out.directive).toBe('abandon');
    if (out.directive !== 'abandon') throw new Error('unreachable');
    expect(out.reason).toContain('stopped');
    expect(stoppedAgents.has('kevin')).toBe(false);   // consumed exactly once
    expect(setAgentStatusSpy).toHaveBeenCalledWith('kevin', 'idle');
  });

  it('ABANDON, PREEMPTED: same shape, its own reason, and the queued wakeup is left to fire', async () => {
    preemptedAgents.add('kevin');
    callModelSpy.mockRejectedValue(new Error('aborted mid-stream'));

    const out = await runCallLLM(freshState(), ctxFor());

    expect(out.directive).toBe('abandon');
    if (out.directive !== 'abandon') throw new Error('unreachable');
    expect(out.reason).toContain('preempted');
    expect(preemptedAgents.has('kevin')).toBe(false);
    expect(setAgentStatusSpy).toHaveBeenCalledWith('kevin', 'idle');
  });

  it('A STEP THAT ASKS TO ABANDON STOPS: no retry, and no hand-back of an ask it never gave up on', async () => {
    // The failure mode the channel exists to remove. An abandoning step that kept
    // running would retry the model call the user just stopped, and would hand back
    // an ask the turn is not finished with.
    stoppedAgents.add('kevin');
    callModelSpy.mockRejectedValue(new Error('aborted mid-stream'));

    await runCallLLM(freshState(), ctxFor({ isAutoRouted: true }));   // 3 attempts available

    expect(callModelSpy).toHaveBeenCalledTimes(1);
    expect(revertTriggerStampOnAbortSpy).not.toHaveBeenCalled();
  });

  it('ABANDON IS NOT EXIT, and the driver honours the difference', () => {
    // `exit` leaves the loop and finalize still runs; `abandon` leaves the TURN and
    // finalize does not. Copying the neighbour's vocabulary would have quietly routed
    // a stopped turn through the reply-destination router.
    const driver = readFileSync(path.resolve(__dirname, '../../../loop.ts'), 'utf8');
    expect(driver).toMatch(/callLLM\.directive === 'abandon'\)\s*return;/);
    // And the shared contract says so once, for the eight steps that share it.
    const shared = readFileSync(path.resolve(__dirname, '../../step-outcome.ts'), 'utf8');
    expect(shared).toMatch(/abandonTurn/);
  });

  it('THE RETRY LADDER COPIES VERBATIM: 2 attempts fixed-model, 3 auto-routed', async () => {
    callModelSpy.mockRejectedValue(new Error('provider exploded'));

    await expect(runCallLLM(freshState(), ctxFor())).rejects.toThrow('provider exploded');
    expect(callModelSpy).toHaveBeenCalledTimes(1);   // fixed model: the non-idle error rethrows at once

    callModelSpy.mockClear();
    await expect(runCallLLM(freshState(), ctxFor({ isAutoRouted: true }))).rejects.toThrow();
    expect(callModelSpy).toHaveBeenCalledTimes(3);
  });

  it('THE ABORT HAND-BACK RUNS ON EVERY GIVE-UP PATH (N-1 / P6b-1)', async () => {
    // Step 1a wrote this guard's requirement down before the span moved; this clause
    // holds it at the new boundary, on both give-up paths.
    callModelSpy.mockRejectedValue(new Error('provider exploded'));
    await expect(runCallLLM(freshState(), ctxFor())).rejects.toThrow();
    expect(revertTriggerStampOnAbortSpy).toHaveBeenCalledTimes(1);

    revertTriggerStampOnAbortSpy.mockClear();
    await expect(runCallLLM(freshState(), ctxFor({ isAutoRouted: true }))).rejects.toThrow();
    expect(revertTriggerStampOnAbortSpy).toHaveBeenCalledTimes(1);
  });

  it('THE CREDENTIAL READ POINT MOVED WITH THE CODE, and it is still the only one', () => {
    // PHASE-5 T6B / RULING P5-R11. The engine's corpus is the driver plus every step
    // package, so this clause follows the code through the cut by construction.
    const hits = [...engineText().matchAll(/hydrateCredentialsInMessages\(/g)];
    expect(hits.length).toBe(1);
    expect(stepText()).toContain('hydrateCredentialsInMessages(');
  });
});
