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
import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { insertMessage } from '../../memory/message-store.js';
import { claimAsk, askIdForMessage } from '../../work/store.js';
import * as coldImport1 from '../runtime.js';
import * as coldImport2 from '../../work/task-freshness.js';
import * as coldImport3 from '../../work/engine-checkpoint-note.js';
import * as coldImport4 from '../../work/job-continuation.js';
import * as coldImport5 from '../turn-context.js';
import * as coldImport6 from '../v2/state.js';
import * as coldImport8 from '../agent-status.js';
import * as coldImport9 from '../v2/honest-stop.js';
import * as coldImport10 from '../shared-state.js';
import * as coldImport12 from '../../gateway/routes/agents.js';

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
  state: typeof import('../v2/state.js');
  status: typeof import('../agent-status.js'); park: typeof import('../v2/honest-stop.js'); shared: typeof import('../shared-state.js');
  routes: typeof import('../../gateway/routes/agents.js');
};

beforeEach(async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  m = {
    runtime: coldImport1, fresh: coldImport2,
    note: coldImport3, cont: coldImport4, ctx: coldImport5,
    state: coldImport6,
    status: coldImport8, park: coldImport9, shared: coldImport10,
    routes: coldImport12,
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

async function seedAsk(): Promise<void> {
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
