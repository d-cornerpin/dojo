// ════════════════════════════════════════════════════════════════════════════════════════
// t158 E — ONE PARK QUEUES EXACTLY ONE CONTINUATION.
//
// Ritual run 6 (S1 variant A): at each 75-round cap the park armed its own 1 s timer wake
// (`armToolLoopContinuation`), and in the same moment ask-settlement re-opened the ask and the
// human-conversation drain queued a self-wake that started the next turn ~500 ms later — the
// real continuation. The park's timer then fired while that turn ran and was queued on the
// shared wake set as a fresh wake. After the job's final answer the leftover ran one more turn,
// with no trigger, no root and no ask; it saw only summaries, decided the audit was unfinished,
// re-ran it and sent the owner a second full result.
//
// The real runtime runs here (`handleMessage`, the busy path, the queued-wakeup drain, the run's
// `finally`); only the turn itself is scripted. When the park's timer fires while a turn that
// serves the job's own ask — a LATER turn than the one that parked — is already running, that
// turn is the continuation and the timer's wake is consumed. A real arrival (an owner message, a
// peer) is not a park wake and still gets its turn.
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


async function seedAsk(): Promise<void> {
  const { insertMessage } = await import('../../memory/message-store.js');
  const { claimAsk, askIdForMessage } = await import('../../work/store.js');
  insertMessage({
    id: 'msg-ask', agentId: AGENT, role: 'user', content: 'Audit all 600 pages and report back.',
    lane: 'owner', channel: 'dashboard', senderId: 'owner', authorized: true,
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }),
  } as never);
  claimAsk(askIdForMessage('msg-ask'), AGENT);
}

describe('t158 E — a park yields exactly one continuation turn', () => {
  it('cap -> ask re-opened -> drain wake runs the continuation -> the park\'s timer fires while it runs: after the job\'s answer NO further turn starts', async () => {
    await seedAsk();
    const rt = m.runtime.getAgentRuntime();
    const ran: Array<{ turn: number; root: string | null }> = [];
    let releaseTurn2: () => void = () => undefined;
    const turn2Held = new Promise<void>((r) => { releaseTurn2 = r; });
    const steps: Array<() => Promise<void>> = [];
    const record = (n: number) => ran.push({ turn: n, root: m.ctx.turnContext(AGENT)?.root?.kind ?? null });

    // Turn 1 hits the cap: the REAL park (timer), and the ask's settlement + the drain queue the real continuation.
    steps.push(() => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      record(1);
      m.cont.parkJob(AGENT, 'tool-loop', 'timer');
      m.shared.queueSelfWake(AGENT, 'human-conversation-drain');
    }));
    // Turn 2: the drain's turn, picked up with the SAME ask; the park's timer fires while it runs.
    steps.push(() => engineTurn(2, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      record(2);
      await turn2Held;
    }));
    // Any further turn is the defect: no trigger, no root, nothing owed.
    steps.push(() => engineTurn(3, null, () => { record(3); }));
    steps.push(() => engineTurn(4, null, () => { record(4); }));
    script.run = async () => { await steps.shift()?.(); };

    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);        // the drain: turn 2 starts
    await vi.advanceTimersByTimeAsync(600);        // the park's 1 s timer fires mid-turn-2
    releaseTurn2();                                // the job's final answer; turn 2 ends
    await vi.advanceTimersByTimeAsync(5000);       // long enough for any leftover wake to run
    expect(ran.map((r) => r.turn), 'exactly one continuation ran, and nothing after the answer').toEqual([1, 2]);
  });

  it('a real message arriving while the continuation runs still gets its own turn', async () => {
    await seedAsk();
    const rt = m.runtime.getAgentRuntime();
    const ran: number[] = [];
    let releaseTurn2: () => void = () => undefined;
    const turn2Held = new Promise<void>((r) => { releaseTurn2 = r; });
    const steps: Array<() => Promise<void>> = [];
    steps.push(() => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      ran.push(1);
      m.cont.parkJob(AGENT, 'tool-loop', 'timer');
      m.shared.queueSelfWake(AGENT, 'human-conversation-drain');
    }));
    steps.push(() => engineTurn(2, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      ran.push(2);
      await turn2Held;
    }));
    steps.push(() => engineTurn(3, { kind: 'ask', id: 'msg-new', sourceMessageId: 'msg-new' }, () => { ran.push(3); }));
    steps.push(() => engineTurn(4, null, () => { ran.push(4); }));
    script.run = async () => { await steps.shift()?.(); };

    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);        // the park's timer fires mid-turn-2
    await rt.handleMessage(AGENT, 'a brand new owner message');   // a real arrival, busy: queued
    releaseTurn2();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran, 'the arrival got its turn; the park\'s leftover did not add another').toEqual([1, 2, 3]);
  });

  it('CONTROL: a park whose continuation turn is NOT serving its ask (an owner message ran first) still defers its wake and runs it', async () => {
    await seedAsk();
    const rt = m.runtime.getAgentRuntime();
    const ran: number[] = [];
    let releaseOwner: () => void = () => undefined;
    const ownerHeld = new Promise<void>((r) => { releaseOwner = r; });
    const steps: Array<() => Promise<void>> = [];
    steps.push(() => engineTurn(1, { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' }, async () => {
      ran.push(1);
      await rt.handleMessage(AGENT, 'an unrelated owner message');   // queued on the shared set
      m.cont.parkJob(AGENT, 'tool-loop', 'timer');
    }));
    steps.push(() => engineTurn(2, { kind: 'ask', id: 'msg-owner', sourceMessageId: 'msg-owner' }, async () => {
      ran.push(2);
      await ownerHeld;
    }));
    steps.push(() => engineTurn(3, null, () => { ran.push(3); }));
    script.run = async () => { await steps.shift()?.(); };

    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    releaseOwner();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran, 'the job\'s continuation still runs after the unrelated owner turn').toEqual([1, 2, 3]);
  });
});
