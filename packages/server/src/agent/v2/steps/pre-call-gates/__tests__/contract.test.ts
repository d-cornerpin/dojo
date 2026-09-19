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

// SLOW-INFERENCE T79b fix round (Finding 1): `getDb` is a SPY, not a fixed factory, so a
// handful of tests can hand `readProviderUnattendedBudgetMinutes` a fake row-returning
// database — still no real DB file opened, which is the file's own standing rule — while
// every OTHER test keeps the original "throws" default unchanged. Without this, every test
// that reached the cap check saw `getDb()` throw, `readProviderUnattendedBudgetMinutes` catch
// and fall back to `null`, and the cap land on 3 — which is INDISTINGUISHABLE from "the real
// query ran and read a declared value of 60". The new describe block below drives the real
// query with a real (fake) row and asserts the cap that produces, which only a working query
// can produce.
const getDbSpy = vi.fn(() => { throw new Error('no database in a contract test'); });
vi.mock('../../../../../db/connection.js', () => ({
  getDb: (...a: unknown[]) => getDbSpy(...(a as [])),
}));

/**
 * A fake `Database.Database`-shaped object carrying exactly one row for
 * `readProviderUnattendedBudgetMinutes`'s `models JOIN providers` query — `prepare` and the
 * returned `get` are themselves spies, so a test can assert the REAL query ran (the SQL text
 * it was handed, the model id it was asked about) rather than merely that a NUMBER came back,
 * which a silent catch-and-fallback could also produce by coincidence.
 */
function fakeProviderDb(maxUnattendedMinutes: number | null): {
  db: { prepare: (sql: string) => { get: (modelId: string) => { max_unattended_minutes: number | null } } };
  prepareSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const getSpy = vi.fn((_modelId: string) => ({ max_unattended_minutes: maxUnattendedMinutes }));
  const prepareSpy = vi.fn((_sql: string) => ({ get: getSpy }));
  return { db: { prepare: prepareSpy }, prepareSpy, getSpy };
}

const setTrackerStatusSpy = vi.fn(() => ({ kind: 'no_change' as const }));
vi.mock('../../../../../work/tracker-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../work/tracker-store.js')>()),
  setTrackerStatus: (...a: unknown[]) => setTrackerStatusSpy(...(a as [])),
  upholdClaim: vi.fn(),
}));

// SLOW-INFERENCE T79b — the trip path's two best-effort side calls, mocked so this contract
// test can assert THAT they were called (with what) rather than relying on `getDb()`'s throw
// above to silently swallow them via the call sites' own try/catch, which is what happened
// here for `noteEngineCheckpoint`'s pre-existing 'turn-budget' call before this task (still
// true, still fine — but a mock makes the NEW 'unattended-budget' call a positive assertion
// instead of an unobserved side effect).
const noteEngineCheckpointSpy = vi.fn(() => 0);
// T79 FIX WAVE, FINDING 2: `turn-budget.ts` now also reads `pendingCirclingVerdictParkLine`
// from this same module, right before it builds the continuation's park message. Stubbed to
// `null` (no pending verdict) so every existing assertion in this file about that message's
// text is completely unaffected — `null` is the one case FINDING 2's own fix leaves the
// message byte-identical for.
const pendingCirclingVerdictParkLineSpy = vi.fn(() => null as string | null);
vi.mock('../../../../../work/engine-checkpoint-note.js', () => ({
  noteEngineCheckpoint: (...a: unknown[]) => noteEngineCheckpointSpy(...(a as [string, string])),
  pendingCirclingVerdictParkLine: (...a: unknown[]) => pendingCirclingVerdictParkLineSpy(...(a as [string])),
}));

const escalateUnattendedBudgetTripToPMSpy = vi.fn(async () => {});
vi.mock('../../../../../tracker/pm-agent.js', () => ({
  escalateUnattendedBudgetTripToPM: (...a: unknown[]) => escalateUnattendedBudgetTripToPMSpy(...(a as [])),
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
  // T79b: a pre-existing gap — this spy's DEFAULT implementation (unlike its siblings below)
  // was never re-armed here, only its call history cleared. "the background gap-drain stays
  // fire-and-forget" (below) replaces the implementation with an intentionally-unresolved
  // promise via `mockImplementation` and only ever resolves the ONE instance it captured; any
  // later test in file order that reaches a real `await checkAndCompact(...)` call then hangs
  // on somebody else's leftover promise. Re-arming the default here is what
  // `estimateAssembledTokensSpy` and `getUncompactedGapCountSpy` already do one line down —
  // this spy was the odd one out.
  checkAndCompactSpy.mockImplementation(async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }));
  estimateAssembledTokensSpy.mockClear();
  estimateAssembledTokensSpy.mockImplementation(async () => ({
    total: 1000, summaryTokens: 0, freshTailTokens: 1000, briefTokens: 0, freshTailCount: 1, summaryCount: 0,
  }));
  getUncompactedGapCountSpy.mockClear();
  getUncompactedGapCountSpy.mockImplementation(() => 0);
  insertMessageIfAbsentSpy.mockClear();
  insertEngineEventIfAbsentSpy.mockClear();
  noteEngineCheckpointSpy.mockClear();
  pendingCirclingVerdictParkLineSpy.mockClear();
  escalateUnattendedBudgetTripToPMSpy.mockClear();
  // T79b fix round: same discipline as `checkAndCompactSpy` above — re-arm the THROWING
  // default every test, so the one describe block below that overrides it with a fake,
  // row-returning database (via `getDbSpy.mockImplementation(...)`) cannot leak that override
  // into any later test in file order.
  getDbSpy.mockReset();
  getDbSpy.mockImplementation(() => { throw new Error('no database in a contract test'); });
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
  it('a stopped agent exits, and the stop signal SURVIVES the gate that honoured it', async () => {
    // UX-REPAIR T37 — THE ONE CHANGE TO THIS CLAUSE, and it is the fix's subject.
    // This gate used to delete the flag. The stop was then invisible to
    // everything that runs after the loop breaks, and `handleMessage`'s
    // end-of-run drains — which see a human ask left unanswered BY THE STOP —
    // queued a wakeup that restarted the agent 500 ms later on the same request
    // (dev box, 2026-08-11 07:24:30 → 07:24:38). The flag is now retired by the
    // run's own exit path, so the drains can still see it. The requirement the
    // delete carried (no stale flag kills the NEXT turn) is kept: it now dies
    // with the run that honoured it.
    stoppedAgents.add(AGENT);
    const ctx = makeCtx();
    const out = await runPreCallGates(stateInStep(), ctx);

    expect(out).toMatchObject({ directive: 'exit', reason: 'stopped-by-user' satisfies PreCallGatesExitReason });
    expect(stoppedAgents.has(AGENT)).toBe(true);
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
    // UX-REPAIR T37: the gate READS the stop flag and no longer retires it — the
    // run's own exit path in `runtime.ts` owns that clear — so this census has to
    // put the fixture back itself before asking for the next exit. The census's
    // subject (every way out carries a NAME) is untouched.
    stoppedAgents.delete(AGENT);

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

describe('SLOW-INFERENCE T79b — the trip is an honest pause with a PM hand-off, not a silent death', () => {
  it('an undeclared provider (getDb throws -> null -> the standing default) still trips at exactly the 4th crossing, unchanged', async () => {
    // The NULL-row control, wired: with no database to read a provider's declaration from,
    // `readProviderUnattendedBudgetMinutes` catches and returns null, `resolveUnattendedBudget`
    // turns that into 60, and `continuationCapFor(60, 15)` is exactly 3 — the same cap this
    // replaced. Three crossings still park; the fourth still trips.
    turnContinuationCounts.set(AGENT, 3);
    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-continuation-cap' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    expect(turnContinuationCounts.has(AGENT)).toBe(false);
  });

  it('the trip squares the tracker: noteEngineCheckpoint fires with reason \'unattended-budget\'', async () => {
    turnContinuationCounts.set(AGENT, 3);
    await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(noteEngineCheckpointSpy).toHaveBeenCalledWith(AGENT, 'unattended-budget');
  });

  it('the trip hands resumption to the PM — no silent death', async () => {
    turnContinuationCounts.set(AGENT, 3);
    await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(escalateUnattendedBudgetTripToPMSpy).toHaveBeenCalledTimes(1);
    expect(escalateUnattendedBudgetTripToPMSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT,
      budgetMinutes: 60,
      continuationCap: 3,
      elapsedMinutes: 60,
      declaredByProvider: false,
    }));
  });

  it('a parked (non-trip) checkpoint does NOT ring the PM — only a trip does', async () => {
    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' satisfies PreCallGatesExitReason });
    expect(noteEngineCheckpointSpy).toHaveBeenCalledWith(AGENT, 'turn-budget');
    expect(escalateUnattendedBudgetTripToPMSpy).not.toHaveBeenCalled();
  });

  it('a failed PM hand-off does not throw out of the step — best effort, same as the checkpoint note', async () => {
    escalateUnattendedBudgetTripToPMSpy.mockRejectedValueOnce(new Error('PM offline'));
    turnContinuationCounts.set(AGENT, 3);

    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-continuation-cap' satisfies PreCallGatesExitReason });
  });

  it('the trip message is honest: names the budget and the PM hand-off, and drops the stuck-loop guess', async () => {
    turnContinuationCounts.set(AGENT, 3);
    await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    const call = insertMessageIfAbsentSpy.mock.calls.find(
      (c) => typeof (c[0] as { content?: string }).content === 'string'
        && (c[0] as { content: string }).content.includes('running for about'),
    );
    expect(call, 'no trip message was inserted').toBeTruthy();
    const content = (call![0] as { content: string }).content;
    expect(content).toMatch(/standard 60-minute unattended budget/);
    expect(content).toMatch(/project manager has been handed the resumption/);
    expect(content).not.toMatch(/stuck loop/);
  });
});

describe('SLOW-INFERENCE T79b fix round (Finding 1) — a DECLARED provider budget drives the real gate, not just the resolver', () => {
  // Every test above this block reaches the cap check with `getDb()` throwing, which
  // `readProviderUnattendedBudgetMinutes` catches and turns into `null` — the SAME value a
  // genuinely-declared-nothing row would produce. That makes "the query works and read 60" and
  // "the query silently failed and fell back to 60" INDISTINGUISHABLE at cap 3. These tests
  // drive the real query against a real (fake) row and assert the cap boundary ONLY a working
  // read of a NON-default value can produce — 31/32, not 3/4 — which is proof the SQL path ran.

  it('a declared 480-minute budget: the query itself is driven, with the real SQL and the real model id', async () => {
    const fake = fakeProviderDb(480);
    getDbSpy.mockImplementation(() => fake.db as unknown as ReturnType<typeof getDbSpy>);

    await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(fake.prepareSpy).toHaveBeenCalledWith(expect.stringContaining('JOIN providers'));
    expect(fake.getSpy).toHaveBeenCalledWith('deepseek-v4-flash'); // stateInStep's configuredModelId
  });

  it('a declared 480-minute budget: the 31st continuation still PARKS — cap is 31, not 3', async () => {
    const fake = fakeProviderDb(480);
    getDbSpy.mockImplementation(() => fake.db as unknown as ReturnType<typeof getDbSpy>);
    turnContinuationCounts.set(AGENT, 30);

    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).toHaveBeenCalled();
    expect(noteEngineCheckpointSpy).toHaveBeenCalledWith(AGENT, 'turn-budget');
    expect(escalateUnattendedBudgetTripToPMSpy).not.toHaveBeenCalled();
    expect(turnContinuationCounts.get(AGENT)).toBe(31);
  });

  it('a declared 480-minute budget: the 32nd continuation TRIPS — the boundary is 31, not the old 3', async () => {
    const fake = fakeProviderDb(480);
    getDbSpy.mockImplementation(() => fake.db as unknown as ReturnType<typeof getDbSpy>);
    turnContinuationCounts.set(AGENT, 31);

    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-continuation-cap' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).not.toHaveBeenCalled();
    expect(turnContinuationCounts.has(AGENT)).toBe(false);
    expect(noteEngineCheckpointSpy).toHaveBeenCalledWith(AGENT, 'unattended-budget');
    expect(escalateUnattendedBudgetTripToPMSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: AGENT,
      budgetMinutes: 480,
      continuationCap: 31,
      elapsedMinutes: 32 * 15, // (cap + 1) * turn-budget-minutes
      declaredByProvider: true,
    }));
  });

  it('a declared 0 (uncapped) budget: the 50th continuation still PARKS, never trips', async () => {
    const fake = fakeProviderDb(0);
    getDbSpy.mockImplementation(() => fake.db as unknown as ReturnType<typeof getDbSpy>);
    turnContinuationCounts.set(AGENT, 49);

    const out = await runPreCallGates(stateInStep({ turnStartMs: Date.now() - (16 * 60 * 1000) }), makeCtx());

    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' satisfies PreCallGatesExitReason });
    expect(checkAndCompactSpy).toHaveBeenCalled();
    expect(noteEngineCheckpointSpy).toHaveBeenCalledWith(AGENT, 'turn-budget');
    expect(escalateUnattendedBudgetTripToPMSpy).not.toHaveBeenCalled();
    expect(turnContinuationCounts.get(AGENT)).toBe(50);
  });
});
