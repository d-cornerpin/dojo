// ════════════════════════════════════════════════════════════════════════════════════════
// t116 E1 — THE PRESS THAT LANDED WHILE THE ANSWER WAS ON THE WIRE.
//
// THE RELEASE-BLAST FINDING, in the probe's own words, on both attempts whose press got a
// 200 back from the stop door:
//
//     Attempt 2 — P6 stop: press=200 ok=true, turns at/after 6169=[6169:stop],
//                 replies after press=1 (must be 0)
//     Attempt 3 — P6 stop: press=200 ok=true, turns at/after 6176=[6176:stop],
//                 replies after press=1 (must be 0)
//
// Both leaked rows were the turn's FINAL reply. So the engine recorded the stop correctly —
// `exit_reason=stop`, the jobs frame, all of it — and still put an answer the owner had just
// refused in front of them. "Stop" that stops the bookkeeping and not the reply is the one
// failure mode the button cannot have.
//
// ── WHY THE THREE EXISTING CHECKPOINTS ALL MISSED IT ──
// The fence was read in exactly two places in this step: before the dial, and in the CATCH.
// Both are failure-shaped. A press that lands while the stream is completing produces
// neither: the call does not throw, so the catch never runs, and the pre-call read happened
// before the press existed. `callSucceeded = true; break;` then walked straight out of the
// retry loop and returned the result, after which seven post-call stages ran and the persist
// seam wrote and broadcast the row with no fence read of its own.
//
// ── HOW THIS FILE DRIVES IT, WITHOUT A SLEEP ANYWHERE ──
// The press is delivered BY the provider call itself: `callModelSpy` raises the fence and then
// RESOLVES NORMALLY. That is the race, made deterministic — the stop is live by the instant
// the call returns, and the call succeeded, so the catch is not involved. No timer, no
// ordering luck, no wall-clock window; the same two lines reproduce it every run.
//
// The companion half of E1 — the persist seam's own read, for a press that lands in the
// post-call stages instead — is driven in
// `post-call-classify/__tests__/a-stopped-turn-never-shows-the-reply-it-refused.test.ts`.
// Two reads because there are two windows, and this file owns the first.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { stoppedAgents, preemptedAgents, stopFencedRuns, activeRuns } from '../../../../shared-state.js';
import { runCallLLM, CALL_LLM_PHASE, type CallLLMContext } from '../index.js';
import { FXID } from '../../../../../../../../deploy/checks/fixture-vocabulary.mjs';
const AGENT = FXID.n4;

// ── The step's outside world, in the same shape its sibling clause files use ──
const callModelSpy = vi.fn();
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../model.js')>()),
  callModel: (...a: unknown[]) => callModelSpy(...(a as [])),
  getProviderCeilingTokens: () => null,
  getContextWindow: () => 200_000,
  getModelOutputCap: () => 64_000,
}));

// The broadcaster RECORDS rather than swallows: "did anything user-visible go out?" is half
// of what this file asserts, and a swallowing mock cannot answer it.
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../../../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

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
vi.mock('../../../../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 0 }));
vi.mock('../../../../../router/decide.js', () => ({
  decideTier: () => ({ tier: 'standard', confidence: 0.9, scores: [], rawScore: 0, latencyMs: 0 }),
}));
vi.mock('../../../../../router/selector.js', () => ({
  selectModel: () => ({ modelId: 'test-model', tier: 'standard' }),
  logRouterDecision: () => undefined,
}));
vi.mock('../../../../../router/probe.js', () => ({ maybeProbe: () => undefined }));
vi.mock('../../../../../memory/assembler.js', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    systemPrompt: 'you are an agent', messages: [{ role: 'user', content: 'hello' }],
    systemVolatile: '', reserveTokens: 0,
  }),
}));

const revertTriggerStampOnAbortSpy = vi.fn();

/** The answer the owner refused — the shape the blast's leaked row had: the turn's final text. */
const THE_REFUSED_ANSWER = 'Here is the whole comparison you asked for, with prices.';

const OK_RESULT = {
  content: THE_REFUSED_ANSWER, toolCalls: [], inputTokens: 10, outputTokens: 3,
  stopReason: 'end_turn',
};

function ctxFor(overrides: Partial<CallLLMContext> = {}): CallLLMContext {
  return {
    agentId: AGENT,
    turnCtx: { agentId: AGENT, conversationId: 'conv-1' } as CallLLMContext['turnCtx'],
    turnNumber: 6169,
    db: null as unknown as CallLLMContext['db'],
    counterparty: { kind: 'user', id: 'owner', displayName: 'Owner' } as unknown as CallLLMContext['counterparty'],
    isA2ATurn: false,
    isAutoRouted: false,
    selection: { modelId: 'test-model', routerTier: null, routerConfidence: 0, routerFreshDecision: false, excludedModels: [] },   // t212: chosen in `assemble`
    lastUserMessageContent: 'compare the options for me',
    messages: [{ role: 'user', content: 'compare the options for me' }] as unknown as CallLLMContext['messages'],
    systemPrompt: 'you are an agent',
    assembled: {
      systemEntryIds: [], messageEntryIds: [], allocation: null, freshTailDropped: 0,
      systemVolatile: '', reserveTokens: 0,
    } as unknown as CallLLMContext['assembled'],
    modelContext: {} as unknown as CallLLMContext['modelContext'],
    volatileFrom: undefined,
    steerAwaitingConfirm: null,
    assemblyTurnContext: { latestUserSource: null },
    revertTriggerStampOnAbort: revertTriggerStampOnAbortSpy,
    ...overrides,
  };
}

const freshState = (): AgentTurnState =>
  advance(initState(AGENT, 'test-model'), { phase: CALL_LLM_PHASE, loopCount: 1 });

/** THE PRESS, delivered at the instant the provider call settles — and the call SUCCEEDS.
 *  This is the window all three old checkpoints were blind to, expressed as a side effect
 *  rather than as a race the test has to win. */
const pressStopAsTheAnswerArrives = () => callModelSpy.mockImplementation(async () => {
  stoppedAgents.add(AGENT);
  return OK_RESULT;
});

beforeEach(() => {
  vi.clearAllMocks();
  frames.length = 0;
  stoppedAgents.clear();
  preemptedAgents.clear();
  stopFencedRuns.clear();
  activeRuns.clear();
  callModelSpy.mockResolvedValue(OK_RESULT);
});

// ── §1 — the fourth checkpoint ────────────────────────────────────────────────────────────

describe('§1 a stop that lands as the answer arrives abandons the turn', () => {
  it('⚠ THE RED: the call succeeds, the press is live, and the step abandons instead of returning the reply', async () => {
    pressStopAsTheAnswerArrives();

    const out = await runCallLLM(freshState(), ctxFor());

    // The directive is the whole fix: before the fourth checkpoint this returned `proceed`
    // carrying the result, and the seven post-call stages then shipped it.
    expect(out.directive, 'the step handed a refused reply on to the post-call stages')
      .toBe('abandon');
    // The reason is the owner's press, named as such — a turn that abandoned for an unstated
    // reason is the shape `exit_reason` cannot be derived from honestly.
    expect((out as { reason: string }).reason).toBe('stopped-after-call');
    // And the text itself never left the step. `proceed` is the ONLY arm that carries
    // `result`, so an abandoning outcome cannot hand the answer onward by construction —
    // asserted rather than assumed, because that is the property the person depends on.
    expect(JSON.stringify(out)).not.toContain(THE_REFUSED_ANSWER);
  });

  it('the catch was never involved — this is the SUCCESS path, which is why the old reads missed it', async () => {
    pressStopAsTheAnswerArrives();
    const out = await runCallLLM(freshState(), ctxFor());
    // One dial, resolved not thrown. If the fixture ever starts throwing, the mid-call read
    // at the catch would cover this case and the clause would pass for the wrong reason —
    // so the shape of the drive is asserted too.
    expect(callModelSpy).toHaveBeenCalledTimes(1);
    await expect(callModelSpy.mock.results[0].value).resolves.toMatchObject({
      content: THE_REFUSED_ANSWER,
    });
    expect((out as { reason: string }).reason).not.toBe('stopped-mid-call');
  });

  it('the RUN-SCOPED fence raises it too, not only the liftable flag', async () => {
    // `stoppedAgents` is clearable from outside mid-run by reset-session; `stopFencedRuns` is
    // the stopped run's own fence and is what makes the stop un-talkable-out-of. The
    // checkpoint reads `isStopFenced`, which ORs them, and this is the arm that proves it —
    // a checkpoint reading the raw flag would be green above and red here.
    callModelSpy.mockImplementation(async () => {
      stopFencedRuns.set(AGENT, Date.now());
      return OK_RESULT;
    });
    const out = await runCallLLM(freshState(), ctxFor());
    expect(out.directive).toBe('abandon');
    expect((out as { reason: string }).reason).toBe('stopped-after-call');
  });
});

// ── §2 — the other direction, which is the half that makes the clause mean anything ──────

describe('§2 nothing else was made to abandon', () => {
  it('CONTROL: no press at all — the turn proceeds and the reply is carried onward exactly as before', async () => {
    const out = await runCallLLM(freshState(), ctxFor());
    expect(out.directive, 'the fourth checkpoint is swallowing turns nobody stopped')
      .toBe('proceed');
    expect((out as { result: { content: string } }).result.content).toBe(THE_REFUSED_ANSWER);
  });

  it('CONTROL: a press that arrives and is then LIFTED before the call settles does not abandon', async () => {
    // The fence is read at the checkpoint, not remembered from earlier in the turn. A stop
    // the platform has legitimately retired (a fresh user message, reset-session) must not
    // keep cutting replies for the rest of the run — that is the P3 silent-hang shape the
    // fence's own header warns about, produced by over-guarding.
    callModelSpy.mockImplementation(async () => {
      stoppedAgents.add(AGENT);
      stoppedAgents.delete(AGENT);
      return OK_RESULT;
    });
    const out = await runCallLLM(freshState(), ctxFor());
    expect(out.directive).toBe('proceed');
  });

  it('CONTROL: a press on a DIFFERENT agent is not this agent\'s stop', async () => {
    callModelSpy.mockImplementation(async () => {
      stoppedAgents.add('some-other-agent');
      return OK_RESULT;
    });
    const out = await runCallLLM(freshState(), ctxFor());
    expect(out.directive).toBe('proceed');
  });

  it('a preempt is still a preempt — the stop fix did not creep onto the other abandon', async () => {
    // The step has exactly two abandons and they mean different things: a stop is the owner
    // refusing the answer, a preempt exists so a QUEUED WAKEUP CAN FIRE. Conflating them
    // would silently drop somebody's barge-in.
    callModelSpy.mockImplementation(async () => {
      preemptedAgents.add(AGENT);
      return OK_RESULT;
    });
    const out = await runCallLLM(freshState(), ctxFor());
    // A preempt is consumed at its own checkpoint, which is not on this path — the point of
    // the clause is that the success-side STOP read did not start answering for it.
    expect((out as { reason?: string }).reason).not.toBe('stopped-after-call');
  });
});
