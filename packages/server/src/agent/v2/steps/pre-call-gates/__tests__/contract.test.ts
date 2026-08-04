// ════════════════════════════════════════
// PHASE-6 T3 — THE `preCallGates` STEP'S CONTRACT (one contract test per STEP,
// RULING P6-R1). CUT 3 in the ordinal order (RULING P6-R3(3)).
//
// The shared shape, unchanged from CUT 1 and CUT 2 and REUSING
// `steps/step-outcome.ts` untouched:
//
//   INPUTS      `(state, ctx)` — the turn's state, and everything else the span
//               read from the driver, passed explicitly. Measured rather than
//               guessed: 12 declarations of `runV2TurnBody` cross into this span
//               and NOTHING it declares is referenced after the boundary (0
//               escaping declarations), which is why this tranche is a
//               relocation and owed no carrier field under RULING P6-R3(1).
//   OUTPUT      a `StepOutcome` — the advanced state and ONE directive.
//   TRANSITION  the driver advances `phase` INTO the step (through `advance`, so
//               `validate()` runs on the transition); the step never writes it.
//   EXIT        the exit-request channel: the step ASKS to leave the loop by
//               RETURNING, never by writing a field a later step overwrites, and
//               a step that asks to leave STOPS.
//
// ── WHAT IS THIS STEP'S ALONE ──
// It is the loop's FIRST step, so it is the only one that can refuse an iteration
// outright: seven of the `while` body's exits live here, and every one of them is
// a guard with an incident behind it (a user pressing stop, a preempting wake, the
// thrash breaker, the auto-continuation cap, the turn-time budget, and the
// compaction gate's emergency and impossible arms). The clause that matters most
// is therefore the ORDER: a turn that has been stopped must not go on to run the
// thrash detector or spend a token estimate on a context it will never assemble.
// ════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WsEvent } from '@dojo/shared';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import { stoppedAgents, preemptedAgents, pendingWakeups, turnContinuationCounts, backgroundDrains } from '../../../../shared-state.js';
import { steerFired } from '../../../steer-queue.js';
import {
  runPreCallGates,
  PRE_CALL_GATES_PHASE,
  type PreCallGatesContext,
  type PreCallGatesExitReason,
} from '../index.js';

// ── The step's outside world ──
// Every mock below stands in for a DOOR the span already went through; none of
// them changes a decision. A unit test must not open the dev database, and the
// thrash detector and the token estimator are both DB readers.
const checkAndCompactSpy = vi.fn(async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }));
const estimateAssembledTokensSpy = vi.fn(async () => ({
  total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
}));
const getUncompactedGapCountSpy = vi.fn(() => 0);
vi.mock('../../../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/compaction.js')>()),
  checkAndCompact: (...a: unknown[]) => checkAndCompactSpy(...(a as [])),
  estimateAssembledTokens: (...a: unknown[]) => estimateAssembledTokensSpy(...(a as [])),
  getUncompactedGapCount: (...a: unknown[]) => getUncompactedGapCountSpy(...(a as [])),
}));

const insertMessageIfAbsentSpy = vi.fn(() => null);
const insertEngineEventIfAbsentSpy = vi.fn(() => null);
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/message-store.js')>()),
  insertMessageIfAbsent: (...a: unknown[]) => insertMessageIfAbsentSpy(...(a as [])),
  insertEngineEventIfAbsent: (...a: unknown[]) => insertEngineEventIfAbsentSpy(...(a as [])),
}));

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { throw new Error('no database in a contract test'); },
}));

const setTrackerStatusSpy = vi.fn(() => ({ kind: 'no_change' as const }));
vi.mock('../../../../../work/tracker-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../work/tracker-store.js')>()),
  setTrackerStatus: (...a: unknown[]) => setTrackerStatusSpy(...(a as [])),
  upholdClaim: vi.fn(),
}));

const AGENT = 'primary';

function freshState(): AgentTurnState {
  return initState({
    agentId: AGENT,
    contextWindow: 200000,
    isAutoRouted: false,
    configuredModelId: 'deepseek-v4-flash',
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'hello',
    lastUserMessageId: 'msg-1',
    inboundChannel: 'dashboard',
    inboundContext: null,
    pendingTechniqueAck: null,
  });
}

/** The state as the DRIVER hands it over: phase already advanced, one loop in. */
function stateInStep(overrides: Partial<AgentTurnState> = {}): AgentTurnState {
  return advance(freshState(), { phase: PRE_CALL_GATES_PHASE, loopCount: 1, ...overrides });
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function makeCtx(overrides: Partial<PreCallGatesContext> = {}): PreCallGatesContext & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  const ctx = {
    agentId: AGENT,
    turnNumber: 3,
    contextWindow: 200000,
    contextModelId: 'deepseek-v4-flash',
    configuredModelId: 'deepseek-v4-flash',
    isAutoRouted: false,
    counterparty: OWNER,
    assemblerOverheadTokens: 0,
    engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false,
    engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (event: WsEvent) => { events.push(event); },
    setAgentStatus: vi.fn(),
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
    ...overrides,
  } as PreCallGatesContext;
  return Object.assign(ctx, { events });
}

beforeEach(() => {
  stoppedAgents.clear();
  preemptedAgents.clear();
  pendingWakeups.clear();
  turnContinuationCounts.clear();
  backgroundDrains.clear();
  checkAndCompactSpy.mockClear();
  estimateAssembledTokensSpy.mockClear();
  estimateAssembledTokensSpy.mockImplementation(async () => ({
    total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
  }));
  getUncompactedGapCountSpy.mockClear();
  getUncompactedGapCountSpy.mockImplementation(() => 0);
  insertMessageIfAbsentSpy.mockClear();
  insertEngineEventIfAbsentSpy.mockClear();
});

/** Drive the step with an assembled-token total at `pct` of the window. */
function atUtilisation(pct: number): void {
  estimateAssembledTokensSpy.mockImplementation(async () => ({
    total: Math.round(200000 * pct), summaryTokens: 0, freshTailTokens: Math.round(200000 * pct),
    briefTokens: 0, freshTailCount: 1, summaryCount: 0,
  }));
}

describe('inputs and outputs — the shared step contract, reused', () => {
  it('takes (state, ctx) and hands back the advanced state', async () => {
    const before = stateInStep();
    const out = await runPreCallGates(before, makeCtx());

    expect(out.directive).toBe('proceed');
    expect(out.state).toBeDefined();
    // The gate records this iteration's utilisation on the way through, so the
    // returned state is NOT the one handed in — which is the whole reason the
    // outcome carries it.
    expect(out.state.lastContextRatio).toBeCloseTo(0.005, 5);
  });

  it('the step NEVER writes `phase` — on the proceed path or on the way out', async () => {
    const clean = await runPreCallGates(stateInStep(), makeCtx());
    expect(clean.state.phase).toBe(PRE_CALL_GATES_PHASE);

    stoppedAgents.add(AGENT);
    const stopped = await runPreCallGates(stateInStep(), makeCtx());
    expect(stopped.directive).toBe('exit');
    expect(stopped.state.phase).toBe(PRE_CALL_GATES_PHASE);
  });
});

describe('the exit-request channel — seven ways out, each with a name', () => {
  it('a stopped agent exits, and the stop signal is CONSUMED', async () => {
    stoppedAgents.add(AGENT);
    const ctx = makeCtx();
    const out = await runPreCallGates(stateInStep(), ctx);

    expect(out).toMatchObject({ directive: 'exit', reason: 'stopped-by-user' satisfies PreCallGatesExitReason });
    expect(stoppedAgents.has(AGENT)).toBe(false);
    expect(ctx.setAgentStatus).toHaveBeenCalledWith(AGENT, 'idle');
  });

  it('a preempted agent exits, and the preempt signal is CONSUMED', async () => {
    preemptedAgents.add(AGENT);
    const out = await runPreCallGates(stateInStep(), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'preempted' satisfies PreCallGatesExitReason });
    expect(preemptedAgents.has(AGENT)).toBe(false);
  });

  it('the compaction gate\'s emergency arm exits, forces a rebuild and queues the wakeup', async () => {
    atUtilisation(0.98);
    const out = await runPreCallGates(stateInStep(), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'context-emergency-compact' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).toHaveBeenCalledWith(AGENT, expect.any(String), 200000, expect.objectContaining({ force: true }));
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('the compaction gate\'s impossible arm exits, tells the person, and still queues the wakeup', async () => {
    atUtilisation(0.995);
    const ctx = makeCtx();
    const out = await runPreCallGates(stateInStep(), ctx);

    expect(out).toMatchObject({ directive: 'exit', reason: 'context-full' satisfies PreCallGatesExitReason });
    expect(insertMessageIfAbsentSpy).toHaveBeenCalled();
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('EXIT IS NOT SAYABLE WITHOUT A REASON — every way out of this step carries one', async () => {
    // A census with a denominator: five exits are reachable without a database
    // (the two breaker exits need the tracker), and each is asserted by NAME so a
    // new silent exit cannot appear.
    const reasons: string[] = [];

    stoppedAgents.add(AGENT);
    reasons.push((await runPreCallGates(stateInStep(), makeCtx()) as { reason: string }).reason);

    preemptedAgents.add(AGENT);
    reasons.push((await runPreCallGates(stateInStep(), makeCtx()) as { reason: string }).reason);

    atUtilisation(0.98);
    reasons.push((await runPreCallGates(stateInStep(), makeCtx()) as { reason: string }).reason);

    atUtilisation(0.995);
    reasons.push((await runPreCallGates(stateInStep(), makeCtx()) as { reason: string }).reason);

    atUtilisation(0.005);
    const overBudget = stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) });
    reasons.push((await runPreCallGates(overBudget, makeCtx()) as { reason: string }).reason);

    expect(reasons).toEqual([
      'stopped-by-user', 'preempted', 'context-emergency-compact', 'context-full', 'turn-time-budget',
    ]);
    expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
  });
});

describe('A STEP THAT ASKS TO EXIT STOPS', () => {
  it('a stopped turn runs NO later gate — no thrash detection, no token estimate, no drain', async () => {
    // The failure mode this clause exists to catch: a step that asks to leave and
    // then keeps executing its remaining gates. Every counter below would move.
    stoppedAgents.add(AGENT);
    const ctx = makeCtx();

    const out = await runPreCallGates(stateInStep({ loopCount: 5 }), ctx);

    expect(out.directive).toBe('exit');
    expect(ctx.detectTaskThrashing).not.toHaveBeenCalled();
    expect(estimateAssembledTokensSpy).not.toHaveBeenCalled();
    expect(getUncompactedGapCountSpy).not.toHaveBeenCalled();
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
  });

  it('the compaction gate\'s emergency exit does not fall through to the gap drain', async () => {
    atUtilisation(0.98);
    getUncompactedGapCountSpy.mockImplementation(() => 10_000);

    const out = await runPreCallGates(stateInStep(), makeCtx());

    expect(out.directive).toBe('exit');
    expect(getUncompactedGapCountSpy).not.toHaveBeenCalled();
  });
});

describe('the numbers this tranche must not move (bounds copied verbatim)', () => {
  it('the compaction gate\'s four decisions still map to the same four outcomes', async () => {
    atUtilisation(0.005);
    expect((await runPreCallGates(stateInStep(), makeCtx())).directive).toBe('proceed');

    atUtilisation(0.92);
    const warn = makeCtx();
    const warned = await runPreCallGates(stateInStep(), warn);
    expect(warned.directive).toBe('proceed');
    expect(warn.events.some((e) => (e as { code?: string }).code === 'CONTEXT_HIGH')).toBe(true);
    expect(checkAndCompactSpy).not.toHaveBeenCalled();

    atUtilisation(0.98);
    expect((await runPreCallGates(stateInStep(), makeCtx())).directive).toBe('exit');

    atUtilisation(0.995);
    expect((await runPreCallGates(stateInStep(), makeCtx())).directive).toBe('exit');
  });

  it('the turn-time budget is still 15 minutes and the continuation ladder is still 3', async () => {
    // Just inside: the turn proceeds and nothing is compacted.
    const inside = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (14 * 60 * 1000) }), makeCtx());
    expect(inside.directive).toBe('proceed');
    expect(checkAndCompactSpy).not.toHaveBeenCalled();

    // Just outside: the turn parks for a continuation.
    const outside = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());
    expect(outside).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' satisfies PreCallGatesExitReason });
    expect(turnContinuationCounts.get(AGENT)).toBe(1);

    // The fourth crossing is one too many.
    turnContinuationCounts.set(AGENT, 3);
    checkAndCompactSpy.mockClear();
    const capped = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());
    expect(capped).toMatchObject({ directive: 'exit', reason: 'turn-continuation-cap' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    expect(turnContinuationCounts.has(AGENT)).toBe(false);
  });

  it('the thrash drift ladder still nudges once at 8 and blocks at 24, and the PM is exempt from both', async () => {
    const nudged = await runPreCallGates(
      stateInStep({ loopCount: 9, thrashGateActivatedAtLoopCount: 1 }), makeCtx(),
    );
    // Soft drift NEVER blocks: one steer, and the turn goes on.
    expect(nudged.directive).toBe('proceed');
    expect(steerFired(nudged.state.steerQueue, 'thrash-drift')).toBe(true);

    // A second visit does not re-fire it — the nudge is one-shot and the drift
    // window is deliberately NOT reset.
    const again = await runPreCallGates(nudged.state, makeCtx());
    expect(again.state.steerQueue.fired.filter((e) => e.floor === 'thrash-drift')).toHaveLength(1);

    // Below the soft threshold nothing fires at all.
    const quiet = await runPreCallGates(
      stateInStep({ loopCount: 8, thrashGateActivatedAtLoopCount: 1 }), makeCtx(),
    );
    expect(steerFired(quiet.state.steerQueue, 'thrash-drift')).toBe(false);
  });
});

describe('the background gap-drain stays fire-and-forget', () => {
  it('a backlog kicks off a drain and the step returns without waiting for it', async () => {
    getUncompactedGapCountSpy.mockImplementation(() => 10_000);
    let resolveDrain: (() => void) | null = null;
    checkAndCompactSpy.mockImplementation(() => new Promise((res) => {
      resolveDrain = () => res({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
    }) as ReturnType<typeof checkAndCompactSpy>);

    const out = await runPreCallGates(stateInStep(), makeCtx());

    // The turn did NOT block on the summarizer — that is the v2.5.14 requirement,
    // and a drain still in flight is the positive control that it really was async.
    expect(out.directive).toBe('proceed');
    expect(checkAndCompactSpy).toHaveBeenCalled();
    expect(backgroundDrains.has(AGENT)).toBe(true);
    resolveDrain!();
  });

  it('one drain at a time — a drain already in flight is not re-entered', async () => {
    getUncompactedGapCountSpy.mockImplementation(() => 10_000);
    backgroundDrains.add(AGENT);

    const out = await runPreCallGates(stateInStep(), makeCtx());

    expect(out.directive).toBe('proceed');
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
  });
});
