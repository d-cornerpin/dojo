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
  note: typeof import('../../work/engine-checkpoint-note.js'); ctx: typeof import('../turn-context.js');
  state: typeof import('../v2/state.js'); gate: typeof import('../v2/steps/preflight/closeout-gate.js');
  status: typeof import('../agent-status.js'); shared: typeof import('../shared-state.js');
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
    note: await import('../../work/engine-checkpoint-note.js'), ctx: await import('../turn-context.js'),
    state: await import('../v2/state.js'), gate: await import('../v2/steps/preflight/closeout-gate.js'),
    status: await import('../agent-status.js'), shared: await import('../shared-state.js'),
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
  m.note.armToolLoopContinuation(AGENT);
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
    const { noteEngineCheckpoint, queueJobContinuation } = m.note;
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
    const { noteEngineCheckpoint, queueJobContinuation } = m.note;
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
