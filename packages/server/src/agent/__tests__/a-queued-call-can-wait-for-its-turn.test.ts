// v3.5 field fix 3, review M5: A CALLER WHOSE CALL WAS QUEUED CAN WAIT FOR THE TURN THAT SERVES IT.
//
// `handleMessage` answers 'queued' when the agent is mid-run: it only adds a pending wakeup, and the
// turn that reads what the caller persisted runs later. The PM review must judge its coverage on THAT
// turn, so the runtime says when it ends: `whenQueuedRunEnds` resolves at the end of the next run that
// STARTS after it was asked, never the run already in flight.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-queued-wait', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const turns = vi.hoisted(() => ({ gates: [] as Array<() => void>, started: 0 }));
vi.mock('../v2/loop.js', () => ({
  runV2Turn: vi.fn(() => new Promise<void>((resolve) => { turns.started += 1; turns.gates.push(resolve); })),
}));

import { runMigrations } from '../../db/migrations.js';
import { getAgentRuntime } from '../runtime.js';
import { activeRuns, pendingWakeups, stoppedAgents } from '../shared-state.js';

const AGENT = 'queued-wait-agent';
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Agent', 'idle', 'sensei')").run(AGENT);
  turns.gates.length = 0; turns.started = 0;
});
afterEach(async () => {
  stoppedAgents.delete(AGENT);
  while (turns.gates.length) turns.gates.shift()!();
  await until(() => !activeRuns.has(AGENT) && !pendingWakeups.has(AGENT));
  mockDb.current?.close(); mockDb.current = null;
});

describe('M5: whenQueuedRunEnds', () => {
  it('a queued call resolves when the QUEUED turn ends, not when the run in flight does', async () => {
    const rt = getAgentRuntime();
    const first = rt.handleMessage(AGENT, '');
    await until(() => turns.started === 1);
    expect(await rt.handleMessage(AGENT, '')).toBe('queued');
    let done: string | null = null;
    void rt.whenQueuedRunEnds(AGENT).then((o) => { done = o; });

    turns.gates.shift()!();            // the run in flight ends
    expect(await first).toBe('ran');
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBeNull();           // ...which is not the turn the queued call waits for

    await until(() => turns.started === 2);   // the queued wakeup turn starts
    expect(done).toBeNull();
    turns.gates.shift()!();            // and ends
    await until(() => done !== null);
    expect(done).toBe('ran');
  });

  it('a terminated agent answers the waiter at once with not-run', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(AGENT);
    const rt = getAgentRuntime();
    const waiting = rt.whenQueuedRunEnds(AGENT);
    expect(await rt.handleMessage(AGENT, '')).toBe('not-run');
    expect(await waiting).toBe('not-run');
  });
});

// Review round 2 (R5): a queued wakeup the runtime DECLINES leaves no caller waiting.
describe('R5: a declined queued wakeup answers its waiters not-run', () => {
  async function queueBehindARun(): Promise<{ result: () => string | null; first: Promise<unknown> }> {
    const rt = getAgentRuntime();
    const first = rt.handleMessage(AGENT, '');
    await until(() => turns.started === 1);
    expect(await rt.handleMessage(AGENT, '')).toBe('queued');
    let done: string | null = null;
    void rt.whenQueuedRunEnds(AGENT).then((o) => { done = o; });
    return { result: () => done, first };
  }

  it('the user stopped the agent while the wakeup was armed: the waiter gets not-run, and no turn runs', async () => {
    const q = await queueBehindARun();
    turns.gates.shift()!();
    await q.first;
    stoppedAgents.add(AGENT);          // the stop lands inside the 500 ms the drain timer is armed
    await until(() => q.result() !== null, 3000);
    expect(q.result()).toBe('not-run');
    expect(turns.started).toBe(1);
  });

  it('the agent entered a stop state (terminated) before the wakeup fired: the waiter gets not-run', async () => {
    const q = await queueBehindARun();
    turns.gates.shift()!();
    await q.first;
    mockDb.current!.prepare("UPDATE agents SET status = 'terminated' WHERE id = ?").run(AGENT);
    await until(() => q.result() !== null, 3000);
    expect(q.result()).toBe('not-run');
    expect(turns.started).toBe(1);
  });
});
