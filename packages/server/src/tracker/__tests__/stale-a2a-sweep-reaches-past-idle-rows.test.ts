// ════════════════════════════════════════════════════════════════════════════════════════
// bug #980 — THE STALE-A2A SWEEP MUST REACH PAST THE ROWS IT WILL NEVER CLOSE.
//
// `runPokeCheck`'s A2A sweeper (pm-agent.ts) selected its candidates with `LIMIT 50` and NO
// `ORDER BY`, then dropped every row whose receiver had sent no assistant message since the
// row opened — in JavaScript, AFTER the limit. Rows whose receiver stayed silent fail that
// check forever and refill the window on every minute's tick. Once 50 such rows exist, the
// scan never reaches a newer row whose receiver WAS active and DID just answer in its reply
// — the one row the sweep exists to close. It sits `on_deck` for the rest of its life.
//
// The shape below is the trap at its smallest: 51 silent rows sorted ahead of the window and
// exactly one row past them whose receiver answered. The fix moves the activity test into the
// WHERE clause (EXISTS over messages) and gives the scan an ORDER BY, so LIMIT 50 is applied
// to the rows the sweep can actually close.
//
// Harness: the t151 one — full migration chain, real module graph, real `setTrackerStatus`
// close path. Only the phone, the socket, the A2A transport, the runtime and the model are
// replaced. All agents, ids and threads are fake.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-stale-a2a-sweep-limit');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-stale-a2a-sweep-limit');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-stale-a2a-sweep-limit', 'dojo.db'),
  };
});

const { broadcasts, transport, a2a } = vi.hoisted(() => ({
  broadcasts: [] as Array<Record<string, unknown>>,
  transport: [] as string[],
  a2a: [] as Array<{ toAgent?: string; payload?: string; threadId?: string }>,
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
    getAgentUptime: () => 0,
  }),
  stopAgent: vi.fn(),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async (env: { toAgent?: string; payload?: string; threadId?: string }) => {
    a2a.push(env);
    return { delivered: true, threadId: env.threadId ?? 't' };
  }),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));
// The PM review fires unawaited at the end of the tick (51 active rows guarantee it); an
// empty reply means it reads the situation report and rules nothing.
vi.mock('../../agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/model.js')>()),
  callModel: vi.fn(async () => ({ content: '' })),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';

// The full migration chain boots per file; an import cost, not a timing assertion.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { runPokeCheck } from '../pm-agent.js';
import { listTasks } from '../schema.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;
const OWNER = 'owner@example.test';

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  broadcasts.length = 0;
  a2a.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('pm', 'PM', 'idle', 'm-a', 'sensei'), ('primary', 'Main', 'idle', 'm-a', 'sensei'),
    ('sleeper', 'Sleeper', 'idle', 'm-a', 'apprentice'), ('talker', 'Talker', 'idle', 'm-a', 'apprentice')`).run();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const nn = (i: number): string => String(i).padStart(2, '0');

describe('stale-A2A sweep reaches past the rows it will never close', () => {
  it('closes the one row whose receiver answered, even with 51 silent rows sorted ahead of it', async () => {
    const now = Date.now();
    const idleAt = now - 45 * MIN;   // every row below is past the 30-min grace
    const busyAt = now - 35 * MIN;   // also past the grace, but NEWER than all the silent rows

    // 51 engine-made assignments whose receiver never said a word afterwards. These are the
    // rows that fail the activity test on every tick and, pre-fix, refilled LIMIT 50 forever.
    // Inserted first and id-sorted first, so every plausible scan order (rowid, work id,
    // a2a_thread_id) meets them before the row that must be reached.
    for (let i = 1; i <= 51; i++) {
      seedTrackerTask(db(), {
        id: `task-${nn(i)}`, agentId: 'sleeper', status: 'on_deck', title: `assignment ${nn(i)}`,
        a2a_thread_id: `thread-sleep-${nn(i)}`,
        opened_at: idleAt, updated_at: idleAt,
      } as never);
    }

    // The row the sweep exists for: receiver active (one assistant message after the row
    // opened — they answered the assignment in their reply), row itself left on_deck.
    seedTrackerTask(db(), {
      id: 'task-52', agentId: 'talker', status: 'on_deck', title: 'assignment 52',
      a2a_thread_id: 'thread-talk-99',
      opened_at: busyAt, updated_at: busyAt,
    } as never);
    // C9: the signal is the receiver's RECORDED reply on this ticket's own thread, not a clock.
    db().prepare(`
      INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent)
      VALUES ('reply-99', 'talker', 'thread-talk-99', 'COMPLETE')
    `).run();
    // `sleeper` sent nothing, ever — no assistant message after any silent row opened.

    await runPokeCheck();
    // The PM review the tick fires at the end is unawaited; let it flush so it cannot land
    // after the assertions below.
    await new Promise((r) => setTimeout(r, 15));

    // The reachable row is closed the way the sweep closes it: status 'fallen' (state
    // 'failed', where setTrackerStatus('fallen') lands it).
    const closed = listTasks({}).find((t) => t.id === 'task-52');
    expect(closed?.status).toBe('fallen');
    expect((db().prepare(`SELECT state FROM work WHERE id = 'task-52'`).get() as { state: string }).state)
      .toBe('failed');

    // The 51 silent rows stay exactly as they were: the sweep must not touch them (their
    // failure path is the in_progress poke chain, not this sweep), and the limit must not
    // be what hides them either — the EXISTS filter, not the window, is what drops them.
    for (let i = 1; i <= 51; i++) {
      const r = db().prepare(`SELECT state, updated_at FROM work WHERE id = ?`).get(`task-${nn(i)}`) as { state: string; updated_at: number };
      expect(r.state, `task-${nn(i)} state`).toBe('on_deck');
      expect(r.updated_at, `task-${nn(i)} updated_at`).toBe(idleAt);
    }
  });
});
