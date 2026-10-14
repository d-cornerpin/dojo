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
// `finally`); only the turn itself is scripted. The rule is kept by BOOKKEEPING, not timing: the
// park's timer wake carries a token; the drain run that starts to serve the job's own ask IS the
// continuation and spends it at run START (before any turn context exists); the timer finds its
// token spent and does nothing, busy or idle. A park with no ask is never spent, and a real arrival
// (a call without `job:true`) is untouched.
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
const askState = (state: string): void => {
  mockDb.current!.prepare("UPDATE work SET state = ?, closed_at = ? WHERE kind = 'ask' AND root_id = 'msg-ask'")
    .run(state, state === 'abandoned' ? Date.now() : null);
};
const ASK_ROOT: Root = { kind: 'ask', id: 'msg-ask', sourceMessageId: 'msg-ask' };

/** Turn 1 hits the cap: the REAL park (timer); settlement re-opens the ask and the drain queues the wake. */
function capTurn(ran: number[]): () => Promise<void> {
  return () => engineTurn(1, ASK_ROOT, async () => {
    ran.push(1);
    m.cont.parkJob(AGENT, 'tool-loop', 'timer');
    askState('open');
    m.shared.queueSelfWake(AGENT, 'human-conversation-drain');
  });
}
/** The drain's turn: picks the ask up again and ends by answering it (the ask is closed). */
function drainTurn(ran: number[], hold?: Promise<void>): () => Promise<void> {
  return () => engineTurn(2, ASK_ROOT, async () => {
    ran.push(2);
    askState('claimed');
    if (hold) await hold;
    askState('abandoned');
  });
}
const idleTurn = (n: number, ran: number[]) => () => engineTurn(n, null, () => { ran.push(n); });

describe('t158 E — a park yields exactly one continuation turn', () => {
  it('(a) the Run 6 order: cap, drain run at +500 ms, timer at +1000 ms while it is busy: one continuation, nothing after the answer', async () => {
    await seedAsk();
    const ran: number[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const steps = [capTurn(ran), drainTurn(ran, held), idleTurn(3, ran), idleTurn(4, ran)];
    script.run = async () => { await steps.shift()?.(); };
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);        // the drain run starts
    await vi.advanceTimersByTimeAsync(600);        // the park's timer fires mid-run
    release();                                     // the job's final answer
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toEqual([1, 2]);
  });

  it('(b) SLOW PREFLIGHT: the drain run is started (activeRuns) but has no turn context when the timer fires: same result', async () => {
    await seedAsk();
    const ran: number[] = [];
    let release: () => void = () => undefined;
    const slowPreflight = new Promise<void>((r) => { release = r; });
    const steps = [capTurn(ran), async () => { await slowPreflight; await drainTurn(ran)(); }, idleTurn(3, ran), idleTurn(4, ran)];
    script.run = async () => { await steps.shift()?.(); };
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);        // the drain run has started, preflight still running
    expect(m.ctx.turnContext(AGENT), 'no turn context yet').toBeFalsy();
    await vi.advanceTimersByTimeAsync(600);        // the timer fires into that window
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toEqual([1, 2]);
  });

  it('(c) IDLE: the continuation finished inside the second; the timer then fires on an idle agent and starts no run', async () => {
    await seedAsk();
    const ran: number[] = [];
    const steps = [capTurn(ran), drainTurn(ran), idleTurn(3, ran), idleTurn(4, ran)];
    script.run = async () => { await steps.shift()?.(); };
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(700);        // the drain run starts and finishes
    expect(ran).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(5000);       // the timer fires on an idle agent
    expect(ran).toEqual([1, 2]);
  });

  it('(d) a tool-loop park with NO ask (no drain): the timer is the only continuation, and it runs', async () => {
    const ran: number[] = [];
    const steps = [
      () => engineTurn(1, null, () => { ran.push(1); m.cont.parkJob(AGENT, 'tool-loop', 'timer'); }),
      idleTurn(2, ran), idleTurn(3, ran),
    ];
    script.run = async () => { await steps.shift()?.(); };
    await m.runtime.getAgentRuntime().handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toEqual([1, 2]);
  });

  it('(e) a real message arriving while the continuation is busy still gets its own turn', async () => {
    await seedAsk();
    const ran: number[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    const steps = [capTurn(ran), drainTurn(ran, held), idleTurn(3, ran), idleTurn(4, ran)];
    script.run = async () => { await steps.shift()?.(); };
    const rt = m.runtime.getAgentRuntime();
    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await rt.handleMessage(AGENT, 'a brand new owner message');   // a real arrival, busy: queued
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran, 'the arrival got its turn; the park\'s timer added none').toEqual([1, 2, 3]);
  });

  it('CONTROL: an owner turn that runs before the continuation does not spend the park\'s wake; the continuation still runs', async () => {
    await seedAsk();
    const ran: number[] = [];
    let release: () => void = () => undefined;
    const ownerHeld = new Promise<void>((r) => { release = r; });
    const rt = m.runtime.getAgentRuntime();
    const steps = [
      () => engineTurn(1, ASK_ROOT, async () => {
        ran.push(1);
        await rt.handleMessage(AGENT, 'an unrelated owner message');   // queued on the shared set
        m.cont.parkJob(AGENT, 'tool-loop', 'timer');
      }),
      () => engineTurn(2, { kind: 'ask', id: 'msg-owner', sourceMessageId: 'msg-owner' }, async () => { ran.push(2); await ownerHeld; }),
      idleTurn(3, ran),
    ];
    script.run = async () => { await steps.shift()?.(); };
    await rt.handleMessage(AGENT, 'the job');
    await vi.advanceTimersByTimeAsync(1200);
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran, 'the job\'s continuation still runs after the unrelated owner turn').toEqual([1, 2, 3]);
  });
});
