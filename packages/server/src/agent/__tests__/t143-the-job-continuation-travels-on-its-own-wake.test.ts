// ════════════════════════════════════════════════════════════════════════════════════════
// t143 ROUND 6 — THE JOB TRAVELS ON ITS OWN CONTINUATION WAKE; IT CANNOT BE STOLEN OR ORPHANED.
//
// The real runtime (`agent/runtime.ts`: `handleMessage`, the busy path, the queued-wakeup drain, the
// run's `finally`) runs here; only the turn itself (`runV2Turn`) is scripted. A scripted turn does
// exactly what the engine's turns do at a park: it opens its turn context, calls the real checkpoint
// writer and the park's wake helper, and ends. The close-out gate is the real gate.
//
// THE REAL ORDER (the round-5 review's trace): the owner's message arrives mid-job and is queued on the
// shared wake set; the job parks (the tool-loop cap) and its own continuation is armed on a 1 s timer;
// the drain runs the OWNER's turn first; the timer fires while that turn is still running; the
// continuation follows. Throughout: the carry is intact, the gate names nothing, and no PM rung sees an
// abandoned task (the PM leaves exactly `jobCarriedIds` alone).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

const { script } = vi.hoisted(() => ({ script: { run: async (): Promise<void> => undefined } }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: () => script.run() }));

const AGENT = 'job-agent';
const MIN = 60_000;

/** Every module the scripts use, loaded BEFORE the fake clock starts (a first import waits on real IO). */
let m: {
  runtime: typeof import('../runtime.js'); fresh: typeof import('../../work/task-freshness.js');
  note: typeof import('../../work/engine-checkpoint-note.js'); cont: typeof import('../../work/job-continuation.js'); ctx: typeof import('../turn-context.js');
  state: typeof import('../v2/state.js'); gate: typeof import('../v2/steps/preflight/closeout-gate.js');
  status: typeof import('../agent-status.js'); park: typeof import('../v2/honest-stop.js'); shared: typeof import('../shared-state.js');
  rl: typeof import('../rate-limit-retry.js'); routes: typeof import('../../gateway/routes/agents.js');
};

beforeEach(async () => {
  vi.resetModules();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  const { seedTrackerTask } = await import('../../work/__tests__/work-fixture.js');
  m = {
    runtime: await import('../runtime.js'), fresh: await import('../../work/task-freshness.js'),
    note: await import('../../work/engine-checkpoint-note.js'), cont: await import('../../work/job-continuation.js'), ctx: await import('../turn-context.js'),
    state: await import('../v2/state.js'), gate: await import('../v2/steps/preflight/closeout-gate.js'),
    status: await import('../agent-status.js'), park: await import('../v2/honest-stop.js'), shared: await import('../shared-state.js'),
    rl: await import('../rate-limit-retry.js'), routes: await import('../../gateway/routes/agents.js'),
  };
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Worker', 'idle', NULL)").run(AGENT);
  const now = Date.now();
  seedTrackerTask(db, {
    id: 'task-job', agentId: AGENT, status: 'in_progress', title: 'the long research job',
    opened_at: now - 60 * MIN, updated_at: now - 30 * MIN, origin_conv_key: 'c-job',
    source_message_id: 'msg-ask', priority: 'normal',
  } as never);
});

afterEach(() => {
  m.shared.pendingWakeups.delete(AGENT);
  m.fresh.endJobCarry(AGENT);
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

type Root = { kind: 'ask' | 'engine'; id: string; sourceMessageId: string | null } | null;

/** One scripted engine turn: its own turn context, its body, then it ends (as the engine's does). */
async function engineTurn(turnNumber: number, root: Root, body: () => Promise<void> | void): Promise<void> {
  const { openTurnContext, endTurnContext } = m.ctx;
  const tc = openTurnContext(AGENT);
  tc.turnNumber = turnNumber;
  tc.root = root;
  try { await body(); } finally { endTurnContext(AGENT); }
}

/** The real close-out gate, as a trigger-less continuation turn meets it. */
async function gateNames(): Promise<string[]> {
  const { initState } = m.state;
  const { runCloseoutGate } = m.gate;
  const tc = m.ctx.turnContext(AGENT)!;
  tc.state = initState({
    agentId: AGENT, contextWindow: 128_000, isAutoRouted: false, configuredModelId: 'm-a', turnNumber: tc.turnNumber ?? 0,
    triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: null, inboundContext: null, pendingTechniqueAck: null,
  });
  await runCloseoutGate(tc, { agentId: AGENT } as never, { db: mockDb.current!, triggerRow: undefined as never });
  return [...(tc.state!.danglingTaskIds ?? [])];
}

const touchedAt = (): number => (mockDb.current!.prepare("SELECT updated_at AS u FROM work WHERE id = 'task-job'").get() as { u: number }).u;

/** The park the engine makes at the 75-call cap: the real checkpoint writer and the real helper that
 *  arms the park's own continuation. */
async function toolLoopPark(): Promise<void> {
  m.note.noteEngineCheckpoint(AGENT, 'tool-loop');
  m.cont.armToolLoopContinuation(AGENT);
}

describe('ROUND 6: the job travels on its own continuation wake', () => {
  it('an owner message queued mid-job is served first; the job\'s continuation (deferred behind it) still carries the job — carry intact, no refusal', async () => {
    const { jobCarriedIds } = m.fresh;
    const rt = m.runtime.getAgentRuntime();
    const seen: Array<{ turn: string; carried: string[]; gate?: string[] }> = [];
    let releaseOwnerTurn: () => void = () => undefined;
    const ownerTurnHeld = new Promise<void>((r) => { releaseOwnerTurn = r; });
    const steps: Array<() => Promise<void>> = [];

    // Turn 1: the job's turn. The owner's unrelated message arrives while it runs; it hits the cap and parks.
    steps.push(() => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      await rt.handleMessage(AGENT, 'an unrelated owner message');   // busy: queued on the shared wake set
      await toolLoopPark();
    }));
    // Turn 2: the drain runs the OWNER's turn first (it has a root and no job).
    steps.push(() => engineTurn(2, { kind: 'ask', id: 'msg-owner', sourceMessageId: 'msg-owner' }, async () => {
      seen.push({ turn: 'owner', carried: jobCarriedIds(AGENT) });
      await ownerTurnHeld;                                             // the 1 s timer fires while this runs
    }));
    // Turn 3: the job's continuation (trigger-less). The gate meets a stale task that is the job.
    steps.push(() => engineTurn(3, null, async () => {
      seen.push({ turn: 'continuation-1', carried: jobCarriedIds(AGENT), gate: await gateNames() });
      await toolLoopPark();                                            // and parks again
    }));
    // Turn 4: the next continuation finishes the work without parking: the chain ends cleanly.
    steps.push(() => engineTurn(4, null, async () => {
      seen.push({ turn: 'continuation-2', carried: jobCarriedIds(AGENT), gate: await gateNames() });
    }));
    script.run = async () => { await steps.shift()?.(); };

    await rt.handleMessage(AGENT, 'the job');                          // turn 1
    await vi.advanceTimersByTimeAsync(500);                            // the drain: the owner's turn starts
    await vi.advanceTimersByTimeAsync(600);                            // the park's 1 s timer fires mid-owner-turn
    expect(jobCarriedIds(AGENT), 'while the owner\'s turn runs, the job is still in flight').toEqual(['task-job']);
    releaseOwnerTurn();
    await vi.advanceTimersByTimeAsync(600);                            // the drain: the continuation starts
    await vi.advanceTimersByTimeAsync(1500);                           // its park's timer: the next continuation
    await vi.advanceTimersByTimeAsync(1500);

    expect(seen.map((s) => s.turn)).toEqual(['owner', 'continuation-1', 'continuation-2']);
    expect(seen[0].carried, 'the owner\'s turn does not take the job').toEqual(['task-job']);
    expect(seen[1].carried).toEqual(['task-job']);
    expect(seen[1].gate, 'zero gate refusals on the stale job').toEqual([]);
    expect(touchedAt(), 'the continuation\'s park still knows the job').toBeGreaterThan(Date.now() - 30 * MIN);
    expect(seen[2].carried).toEqual(['task-job']);
    expect(seen[2].gate).toEqual([]);
    // The chain ended cleanly: nothing carries the task now, and a later turn judges it like any other.
    expect(jobCarriedIds(AGENT)).toEqual([]);
    vi.setSystemTime(Date.now() + 15 * MIN);
    await engineTurn(9, null, async () => { expect(await gateNames()).toContain('task-job'); });
  });
});

describe('ROUND 6 (R5-I1): a carry whose chain truly ends does not outlive it', () => {
  it('a skipped continuation (the drain\'s stop-state branch) ends the carry: the task is judgeable as abandoned again', async () => {
    const { jobCarriedIds } = m.fresh;
    const { noteEngineCheckpoint } = m.note; const { queueJobContinuation } = m.cont;
    script.run = () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, () => {
      noteEngineCheckpoint(AGENT, 'turn-budget');
      queueJobContinuation(AGENT, 'turn-budget-continuation');
    });
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    expect(jobCarriedIds(AGENT)).toEqual(['task-job']);
    mockDb.current!.prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(AGENT);   // not through the writer
    await vi.advanceTimersByTimeAsync(600);                                                     // the drain skips the wake
    expect(jobCarriedIds(AGENT)).toEqual([]);
    vi.setSystemTime(Date.now() + 15 * MIN);
    await engineTurn(9, null, async () => { expect(await gateNames()).toContain('task-job'); });
  });

  it('an agent that leaves the running states through the one status writer (terminated, error, paused, rate-limited) ends the carry', async () => {
    const { jobCarriedIds } = m.fresh;
    const { setAgentStatus } = m.status;
    const { noteEngineCheckpoint } = m.note; const { queueJobContinuation } = m.cont;
    for (const status of ['terminated', 'error', 'paused', 'rate_limited'] as const) {
      script.run = () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, () => {
        noteEngineCheckpoint(AGENT, 'turn-budget');
        queueJobContinuation(AGENT, 'turn-budget-continuation');
      });
      mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
      await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
      expect(jobCarriedIds(AGENT), `${status}: before`).toEqual(['task-job']);
      setAgentStatus(AGENT, status);
      expect(jobCarriedIds(AGENT), `${status}: after`).toEqual([]);
    }
  });
});

describe('MERGE (t143 + t148): the one status writer does both jobs', () => {
  const carry = async (): Promise<void> => {
    script.run = () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, () => {
      m.note.noteEngineCheckpoint(AGENT, 'turn-budget');
      m.cont.queueJobContinuation(AGENT, 'turn-budget-continuation');
    });
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual(['task-job']);
  };
  const lastError = (): string | null => (mockDb.current!.prepare('SELECT last_error AS e FROM agents WHERE id = ?').get(AGENT) as { e: string | null }).e;

  it('a carrying agent that is PARKED (paused + tag) is not shielded: its carry ends and the task is judged again', async () => {
    await carry();
    m.park.parkAgent(AGENT, { kind: 'budget_stop', words: 'the daily limit was reached', budget: null });
    expect(lastError()).toMatch(/^\[budget_stop\]/);
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
    vi.setSystemTime(Date.now() + 15 * MIN);
    await engineTurn(9, null, async () => { expect(await gateNames()).toContain('task-job'); });
  });

  it('a plain paused write over a park clears the park tag AND ends the carry (one statement path, both effects)', async () => {
    m.park.parkAgent(AGENT, { kind: 'no_model_fits', words: 'no model fits', budget: null });
    expect(lastError()).toMatch(/^\[no_model_fits\]/);
    await carry();
    m.status.setAgentStatus(AGENT, 'paused');
    expect(lastError()).toBeNull();
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });
});

/** Run the job's first turn (it parks at the tool-loop cap), let its own timer start the carrying
 *  continuation, and return after that continuation has run. */
async function runToCarryingContinuation(carryingBody: () => Promise<void> | void, nextBodies: Array<() => Promise<void> | void> = []): Promise<void> {
  const steps: Array<() => Promise<void>> = [
    () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => { await toolLoopPark(); }),
    () => engineTurn(2, null, carryingBody),
    ...nextBodies.map((b, i) => () => engineTurn(3 + i, null, b)),
  ];
  script.run = async () => { await steps.shift()?.(); };
  await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
  await vi.advanceTimersByTimeAsync(1100);      // the park's own timer starts the carrying continuation
}

describe('ROUND 7 (R6-I1): a carrying run that ends with a wake of its own hands the job to it', () => {
  it('a 429 silent retry of the carrying continuation restarts it AS the job: carry intact in the gap, no refusal on the retry', async () => {
    const seen: Array<{ turn: string; carried: string[]; gate?: string[] }> = [];
    await runToCarryingContinuation(
      () => {
        seen.push({ turn: 'continuation', carried: m.fresh.jobCarriedIds(AGENT) });
        vi.setSystemTime(Date.now() + 15 * MIN);                            // 15 quiet minutes inside the call
        m.rl.scheduleRateLimitRetry(AGENT, null, 'hello');                  // the provider said 429; ends without parking
      },
      [async () => { seen.push({ turn: 'retry', carried: m.fresh.jobCarriedIds(AGENT), gate: await gateNames() }); }],
    );
    expect(seen.map((x) => x.turn)).toEqual(['continuation']);
    expect(m.fresh.jobCarriedIds(AGENT), 'in the 10 s gap the retry carries the job').toEqual(['task-job']);
    await vi.advanceTimersByTimeAsync(11_000);                              // the silent retry fires
    expect(seen.map((x) => x.turn)).toEqual(['continuation', 'retry']);
    expect(seen[1].carried).toEqual(['task-job']);
    expect(seen[1].gate, 'the stale job is not named at the retry').toEqual([]);
    expect(m.fresh.jobCarriedIds(AGENT), 'the retry ended without a further wake: the chain is over').toEqual([]);
  });

  it('a recovery re-queue (queueSelfWake) of the carrying continuation is served by a run that carries the job', async () => {
    const seen: Array<{ turn: string; carried: string[]; gate?: string[] }> = [];
    await runToCarryingContinuation(
      () => {
        seen.push({ turn: 'continuation', carried: m.fresh.jobCarriedIds(AGENT) });
        vi.setSystemTime(Date.now() + 15 * MIN);
        m.shared.queueSelfWake(AGENT, 'recovery-requeue');                  // what the recovery cascade does
      },
      [async () => { seen.push({ turn: 'requeued', carried: m.fresh.jobCarriedIds(AGENT), gate: await gateNames() }); }],
    );
    await vi.advanceTimersByTimeAsync(700);                                 // the drain
    expect(seen.map((x) => x.turn)).toEqual(['continuation', 'requeued']);
    expect(seen[1].carried).toEqual(['task-job']);
    expect(seen[1].gate).toEqual([]);
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });

  it('the turn-budget park with the owner\'s message merged on the same wake: the one drained run serves both and carries the job; its continuation too', async () => {
    const seen: Array<{ turn: string; carried: string[]; carries: boolean; gate?: string[] }> = [];
    const rt = m.runtime.getAgentRuntime();
    const steps: Array<() => Promise<void>> = [
      () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
        await rt.handleMessage(AGENT, 'an unrelated owner message');       // queued on the shared set
        m.note.noteEngineCheckpoint(AGENT, 'turn-budget');
        m.cont.queueJobContinuation(AGENT, 'turn-budget-continuation');     // merges with the owner's wake
      }),
      () => engineTurn(2, { kind: 'ask', id: 'msg-owner', sourceMessageId: 'msg-owner' }, async () => {
        seen.push({ turn: 'merged', carried: m.fresh.jobCarriedIds(AGENT), carries: m.fresh.runCarriesJob(AGENT) });
        vi.setSystemTime(Date.now() + 15 * MIN);
        m.note.noteEngineCheckpoint(AGENT, 'turn-budget');                  // the merged run parks again
        m.cont.queueJobContinuation(AGENT, 'turn-budget-continuation');
      }),
      () => engineTurn(3, null, async () => {
        seen.push({ turn: 'continuation', carried: m.fresh.jobCarriedIds(AGENT), carries: m.fresh.runCarriesJob(AGENT), gate: await gateNames() });
      }),
    ];
    script.run = async () => { await steps.shift()?.(); };
    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    expect(seen.map((x) => x.turn)).toEqual(['merged', 'continuation']);
    expect(seen[0]).toMatchObject({ carried: ['task-job'], carries: true });
    expect(seen[1]).toMatchObject({ carried: ['task-job'], carries: true, gate: [] });
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });
});

describe('ROUND 7 (R6-I1): every other place that clears the shared wake set ends the carry', () => {
  /** The job parked on a turn-budget wake and the wake is still queued. */
  async function parkedWithWakeQueued(): Promise<void> {
    script.run = () => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, () => {
      m.note.noteEngineCheckpoint(AGENT, 'turn-budget');
      m.cont.queueJobContinuation(AGENT, 'turn-budget-continuation');
    });
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual(['task-job']);
  }

  it('the stuck-agent reaper (a wedged run reaped to idle) ends the carry', async () => {
    await parkedWithWakeQueued();
    mockDb.current!.prepare("UPDATE agents SET status = 'working', updated_at = datetime('now', '-3 hours') WHERE id = ?").run(AGENT);
    m.runtime.runStartupRecoverySweep();
    expect(m.shared.pendingWakeups.has(AGENT)).toBe(false);
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });

  it('the stuck-stopped-run reaper ends the carry', async () => {
    await parkedWithWakeQueued();
    m.shared.stopFencedRuns.set(AGENT, Date.now() - 3 * 60 * MIN);
    m.runtime.runStartupRecoverySweep();
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });

  it('the reset-session route ends the carry', async () => {
    await parkedWithWakeQueued();
    const res = await m.routes.agentsRouter.request(`/${AGENT}/reset-session`, { method: 'POST' });
    expect(res.status).toBeLessThan(500);
    expect(m.shared.pendingWakeups.has(AGENT)).toBe(false);
    expect(m.fresh.jobCarriedIds(AGENT)).toEqual([]);
  });
});
