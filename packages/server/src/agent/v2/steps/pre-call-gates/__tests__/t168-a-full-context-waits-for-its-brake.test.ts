// ════════════════════════════════════════════════════════════════════════════════════════
// t168 (v3.3.3 run 9) — A FULL-CONTEXT AGENT IS NOT WOKEN INTO THE SAME WALL.
//
// The witness (a user's box, one agent, 12 minutes): the compaction brake was on, the context
// stood at 99% of its budget, and the gate's block arm did what it does — ran the forced pass
// (skipped: "backing off after a pass that reclaimed nothing"), parked the job and queued a
// wakeup. The wakeup ran half a second later, found the same context and the same brake,
// surrendered again, queued again. 1,216 times, until the agent was terminated. Nothing could
// change between the wakes: only the brake's own expiry, or a pass that reclaims, can.
//
// What is real here: the gate (`runContextGates` through `runPreCallGates`), the real brake
// (`compactionIsBraked` / `notePassOutcome`), the real park (`parkJob`) and the real owner-notice
// door on a migrated in-memory DB. Scripted: the compaction pass itself (it asks the real brake
// first and reports its result to the real brake, as `checkAndCompact` does), the token
// estimate, the runtime the park's timer wakes (a counter), and the owner text (a spy).
//
// "THE DRAIN" below is the runtime's queued-wakeup drain in miniature: when a surrender leaves a
// wake on the shared set, it runs the gate again at once. A bound of 50 stands in for "for ever";
// reaching it IS the defect.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import { stoppedAgents, preemptedAgents, pendingWakeups, turnContinuationCounts, backgroundDrains } from '../../../../shared-state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import { compactionIsBraked, notePassOutcome, noteLowYield, LOW_YIELD_BACKOFF_MS, __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { endJobCarry } from '../../../../../work/task-freshness.js';
import { __resetFullContextWaitForTests } from '../../../full-context-wait.js';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t168-gate', 'dojo.db'),
  };
});

const NONE = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
const WON = { leafCreated: 2, condensedCreated: 1, tokensReclaimed: 5_000 };
/** What the next forced pass that actually runs achieves. */
let nextPass: 'reclaims' | 'nothing' | 'cancelled' = 'nothing';
let passesRun = 0;
let braked = 0;
const checkAndCompactSpy = vi.fn(async (agentId: string) => {
  if (compactionIsBraked(agentId, true)) { braked += 1; return NONE; }   // the entry point's own first question
  passesRun += 1;
  if (nextPass === 'cancelled') {   // the turn cut the pass: it reports to the brake with the signal it was cut by
    const cut = new AbortController(); cut.abort();
    notePassOutcome(agentId, true, NONE, { stage: 'summariser_refused', detail: 'aborted' }, cut.signal);
    return NONE;
  }
  if (nextPass === 'reclaims') { notePassOutcome(agentId, true, WON); return WON; }
  notePassOutcome(agentId, true, NONE, { stage: 'nothing_left_to_condense', detail: 'scripted' });
  return NONE;
});
let utilisation = 0.995;
const estimateAssembledTokensSpy = vi.fn(async () => ({
  total: Math.round(200000 * utilisation), summaryTokens: 0, freshTailTokens: Math.round(200000 * utilisation),
  briefTokens: 0, freshTailCount: 1, summaryCount: 0,
}));
vi.mock('../../../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/compaction.js')>()),
  checkAndCompact: (...a: unknown[]) => checkAndCompactSpy(...(a as [string])),
  estimateAssembledTokens: (...a: unknown[]) => estimateAssembledTokensSpy(...(a as [])),
}));
vi.mock('../../../../../memory/tail-horizon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/tail-horizon.js')>()),
  rowsLeavingView: () => null,
}));

/** The park's timer wake lands here (`armToolLoopContinuation` → the runtime's `handleMessage`). */
const timerWakes: Array<{ agentId: string; opts: unknown }> = [];
vi.mock('../../../../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async (agentId: string, _t: string, opts: unknown) => { timerWakes.push({ agentId, opts }); } }),
}));
const sendAlertSpy = vi.fn();
vi.mock('../../../../../services/imessage-bridge.js', () => ({ sendAlert: (...a: unknown[]) => sendAlertSpy(...a) }));

const AGENT = 'agent-t168-gate';
const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function stateInStep(): AgentTurnState {
  return advance(initState({
    agentId: AGENT, contextWindow: 200000, isAutoRouted: false, configuredModelId: 'deepseek-v4-flash', turnNumber: 3,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'hello', lastUserMessageId: 'msg-1',
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  }), { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
}
function makeCtx(): PreCallGatesContext {
  return {
    agentId: AGENT, turnNumber: 3, contextWindow: 200000, contextModelId: 'deepseek-v4-flash', configuredModelId: 'deepseek-v4-flash',
    isAutoRouted: false, counterparty: OWNER, assemblerOverheadTokens: 0, engineStartAckDeliveredThisTurn: false,
    deferredDeliveredByAck: false, engineBlockEscapeHatch: '[escape hatch]', broadcast: () => undefined,
    stashContinuationIfHuman: vi.fn(), detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
}

/** One run of the gate; the wake the surrender leaves behind is whatever sits on the shared set. */
async function surrender(): Promise<string> {
  const out = await runPreCallGates(stateInStep(), makeCtx());
  return (out as { reason?: string }).reason ?? out.directive;
}
/** The runtime's drain: while a wake is queued, run the gate again, up to a bound standing for "for ever". */
async function drain(bound = 50): Promise<number> {
  let wakes = 0;
  while (pendingWakeups.has(AGENT) && wakes < bound) { pendingWakeups.delete(AGENT); wakes += 1; await surrender(); }
  return wakes;
}
/** The brake the incident had on: a real refusal armed it, and it binds a forced pass too. */
function armTheBrake(): void {
  notePassOutcome(AGENT, true, NONE, { stage: 'summariser_refused', detail: 'scripted refusal', modelId: 'deepseek-v4-flash' });
  expect(compactionIsBraked(AGENT, true), 'non-vacuity: the brake is on and binds a forced pass').toBe(true);
}
const MIN = 60_000;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  db.exec("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, model_id TEXT, session_started_at TEXT, status TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, provider_id TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS healer_state (scope TEXT, key TEXT, at_ms INTEGER, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (scope, key))");
  db.prepare("INSERT INTO agents (id, name, model_id, session_started_at, status) VALUES (?, 'Box Under Test', 'deepseek-v4-flash', '1970-01-01', 'idle')").run(AGENT);
  stoppedAgents.clear(); preemptedAgents.clear(); pendingWakeups.clear(); turnContinuationCounts.clear(); backgroundDrains.clear();
  __resetBrakesForTests();
  __resetFullContextWaitForTests();
  checkAndCompactSpy.mockClear();
  sendAlertSpy.mockClear();
  timerWakes.length = 0;
  nextPass = 'nothing'; passesRun = 0; braked = 0; utilisation = 0.995;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t168 (ii) the measured loop: brake on, context over budget', () => {
  it('ONE surrender, then no wake at all until the brake lets go — no hot loop', async () => {
    armTheBrake();

    expect(await surrender()).toBe('context-full');
    expect(braked, 'the forced pass was asked and the brake said no').toBe(1);
    const hotWakes = await drain();
    expect(hotWakes, 'nothing can change in the next half second, so nothing wakes the agent into it').toBe(0);
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);

    // Twelve simulated minutes, the length of the witness: not one wake, not one more surrender.
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(timerWakes).toEqual([]);
    expect(pendingWakeups.has(AGENT)).toBe(false);
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);
    expect(sendAlertSpy, 'a park is invisible housekeeping: the owner hears nothing').not.toHaveBeenCalled();
  });

  it('the wake comes at the brake\'s own expiry, once', async () => {
    armTheBrake();
    await surrender();

    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS - MIN);
    expect(timerWakes.length, 'a minute before the expiry: still waiting').toBe(0);
    await vi.advanceTimersByTimeAsync(MIN + 5);
    expect(timerWakes.length, 'at the expiry: the agent is woken, once').toBe(1);
    expect(timerWakes[0].agentId).toBe(AGENT);
    expect(compactionIsBraked(AGENT, true), 'and by then the brake has let go').toBe(false);
  });

  it('a pass that just ran and reclaimed nothing waits the same way (the brake it armed is the wall)', async () => {
    nextPass = 'nothing';   // no brake yet; the gate\'s own forced pass runs, wins nothing, arms it
    expect(await surrender()).toBe('context-full');
    expect(passesRun).toBe(1);
    expect(await drain(), 'and does not wake into it half a second later').toBe(0);
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS - MIN);
    expect(timerWakes.length).toBe(0);
    expect(sendAlertSpy, 'the first failed pass is not yet a stop: the brake\'s expiry is the next chance').not.toHaveBeenCalled();
  });

  it('a routine low-yield brake does not hold an emergency: the pass runs and the wake is queued as before', async () => {
    noteLowYield(AGENT);
    expect(compactionIsBraked(AGENT, true), 'non-vacuity: the routine brake yields to a forced pass').toBe(false);
    nextPass = 'cancelled';   // the pass runs and leaves the routine brake exactly as it was
    await surrender();
    expect(passesRun).toBe(1);
    expect(compactionIsBraked(AGENT, false), 'non-vacuity: the routine brake is still on after the pass').toBe(true);
    expect(pendingWakeups.has(AGENT)).toBe(true);
    expect(timerWakes).toEqual([]);
  });

  it('the owner\'s Stop (or a reset) during the wait ends it: the timer does not wake a stopped agent', async () => {
    armTheBrake();
    await surrender();
    endJobCarry(AGENT);   // what `stopAgent` does: a stopped agent's job has no continuation coming
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    expect(timerWakes).toEqual([]);
  });

  it('a pass the turn cancelled leaves no wall: the wake is queued as before (it is not evidence of anything)', async () => {
    nextPass = 'cancelled';
    expect(await surrender()).toBe('context-full');
    expect(passesRun).toBe(1);
    expect(compactionIsBraked(AGENT, true)).toBe(false);
    expect(pendingWakeups.has(AGENT)).toBe(true);
    expect(timerWakes).toEqual([]);
  });

  it('the 96-99% emergency arm waits the same way', async () => {
    utilisation = 0.98;
    armTheBrake();
    expect(await surrender()).toBe('context-emergency-compact');
    expect(await drain()).toBe(0);
    await vi.advanceTimersByTimeAsync(12 * MIN);
    expect(timerWakes.length).toBe(0);
  });

  it('control: with NO brake and a pass that reclaims, the wake is queued at once, as before', async () => {
    nextPass = 'reclaims';
    expect(await surrender()).toBe('context-full');
    expect(pendingWakeups.has(AGENT), 'the rebuild wake the contract test pins').toBe(true);
    expect(timerWakes).toEqual([]);
  });
});

describe('t168 (iii) at the brake\'s expiry', () => {
  it('a pass that reclaims lets the agent continue — and the owner is told nothing', async () => {
    armTheBrake();
    await surrender();
    nextPass = 'reclaims';
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    expect(timerWakes.length).toBe(1);

    expect(await surrender(), 'the woken turn runs the gate: the brake has let go, the pass runs').toBe('context-full');
    expect(passesRun).toBe(1);
    expect(pendingWakeups.has(AGENT), 'it reclaimed, so the continuation is queued now').toBe(true);
    expect(sendAlertSpy).not.toHaveBeenCalled();
  });

  it('a pass that cannot reclaim leads to ONE honest stop, however long it goes on', async () => {
    armTheBrake();
    await surrender();
    nextPass = 'nothing';

    // Four expiries in a row: each wakes the agent once, each pass runs and reclaims nothing.
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
      expect(timerWakes.length, `cycle ${cycle}: one wake per expiry`).toBe(cycle);
      await surrender();
      expect(passesRun, `cycle ${cycle}: the pass really ran at the expiry`).toBe(cycle);
      expect(await drain(), `cycle ${cycle}: and no hot loop in between`).toBe(0);
    }
    expect(sendAlertSpy, 'the owner hears it once, through the existing door').toHaveBeenCalledTimes(1);
    const [words, severity] = sendAlertSpy.mock.calls[0];
    expect(String(words)).toContain('Box Under Test');
    expect(String(words)).toMatch(/stuck/i);
    expect(severity).toBe('notice');
    // and it is the door's own record: a standing card, re-derived from the told-record
    const told = mockDb.current!.prepare("SELECT key FROM healer_state WHERE scope = 'owner_told'").all() as Array<{ key: string }>;
    expect(told.map((t) => t.key)).toEqual([`stuck:${AGENT}`]);
  });

  it('the owner writing mid-wait gets one more silent surrender: no text, no hot wake, no second pass', async () => {
    armTheBrake();
    await surrender();
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    await surrender();                                   // the expiry's pass fails: told, once
    expect(sendAlertSpy).toHaveBeenCalledTimes(1);
    const passesBefore = passesRun;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await surrender();                                   // a message from the owner, mid-wait: the brake is back on
    expect(passesRun, 'the brake held: no second pass').toBe(passesBefore);
    expect(await drain(), 'and no hot wake').toBe(0);
    expect(sendAlertSpy, 'and not told twice').toHaveBeenCalledTimes(1);
  });

  it('a message mid-wait, BEFORE any failed expiry pass, tells the owner nothing', async () => {
    armTheBrake();
    await surrender();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await surrender();
    expect(sendAlertSpy).not.toHaveBeenCalled();
    expect(await drain()).toBe(0);
  });

  it('and when a later pass reclaims, the condition ends: a new incident would be told afresh', async () => {
    armTheBrake();
    await surrender();
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    await surrender();                                   // reclaims nothing: told
    expect(sendAlertSpy).toHaveBeenCalledTimes(1);
    nextPass = 'reclaims';
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    await surrender();                                   // reclaims: continues
    expect(pendingWakeups.has(AGENT)).toBe(true);
    const told = mockDb.current!.prepare("SELECT key FROM healer_state WHERE scope = 'owner_told'").all();
    expect(told, 'the told-record leaves with the condition').toEqual([]);
  });

  it('a context that shrank by itself ends the wait too (the gate sees noop)', async () => {
    armTheBrake();
    await surrender();
    await vi.advanceTimersByTimeAsync(LOW_YIELD_BACKOFF_MS + 5);
    await surrender();                                   // told
    utilisation = 0.4;
    const out = await runPreCallGates(stateInStep(), makeCtx());
    expect(out.directive).toBe('proceed');
    const told = mockDb.current!.prepare("SELECT key FROM healer_state WHERE scope = 'owner_told'").all();
    expect(told).toEqual([]);
  });
});
