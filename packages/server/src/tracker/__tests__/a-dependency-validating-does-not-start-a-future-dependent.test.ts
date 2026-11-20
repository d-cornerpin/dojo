// A dependency validating only makes a dependent eligible. A dependent with a scheduled start still in
// the future waits for it (the scheduler fires it then); one with no start, or a past one, starts now and
// only that one wakes its holder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-pm-dependency-start');
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pm-dependency-start');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-pm-dependency-start', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined), getAgentUptime: () => 0 }),
  stopAgent: vi.fn(),
}));
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: vi.fn(async () => ({ delivered: true })),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { runMigrations } from '../../db/migrations.js';
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { checkDependencies } from '../../work/done/effects.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const db = (): Database.Database => mockDb.current!;
const HOUR = 3_600_000;
const status = (id: string): string => (db().prepare(
  "SELECT CASE state WHEN 'open' THEN 'on_deck' WHEN 'claimed' THEN 'in_progress' ELSE state END AS s FROM work WHERE id = ?",
).get(id) as { s: string }).s;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'P', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'M', 'm')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'idle', 'm-a', 'apprentice'), ('pm', 'PM', 'idle', 'm-a', 'sensei')`).run();
  seedTrackerTask(d, { id: 'dep-1', agentId: 'helper', status: 'in_progress', title: 'the first step' } as never);
  d.prepare(`INSERT INTO deliveries (id, agent_id, conversation_id, tool, channel, outcome, created_at)
             VALUES ('d-1', 'helper', 'conv-1', 'chat', 'dashboard', 'delivered', 1700000000000)`).run();
  d.prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
             VALUES ('dep-1', 'done', 'upheld', 'pm', 1700000000000)`).run();
  d.prepare(`UPDATE work SET state = 'done', closed_at = 1700000000000, result_delivery_id = 'd-1' WHERE id = 'dep-1'`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a dependency validating makes the dependent eligible; it starts at its own time', () => {
  const dependent = (id: string, startMs: number | null): void => {
    seedTrackerTask(db(), {
      id, agentId: 'helper', status: 'on_deck', title: `step ${id}`,
      depends_on: JSON.stringify(['dep-1']), scheduled_start: startMs,
    } as never);
  };

  it('a dependent with a FUTURE scheduled start is not started when its dependency validates', () => {
    dependent('d-future', Date.now() + 5 * HOUR);
    checkDependencies('dep-1');
    expect(status('d-future')).toBe('on_deck');
  });

  it('a dependent with no scheduled start starts at once', () => {
    dependent('d-none', null);
    checkDependencies('dep-1');
    expect(status('d-none')).toBe('in_progress');
  });

  it('a dependent whose scheduled start is already past starts at once', () => {
    dependent('d-past', Date.now() - 2 * HOUR);
    checkDependencies('dep-1');
    expect(status('d-past')).toBe('in_progress');
  });

  it('only the dependent that starts now wakes its holder', async () => {
    const woken = (id: string): number => (db().prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = 'helper' AND lane = 'events' AND task_id = ? AND content LIKE '%is now unblocked%'",
    ).get(id) as { c: number }).c;
    dependent('d-future', Date.now() + 5 * HOUR);
    dependent('d-none', null);
    checkDependencies('dep-1');
    await vi.waitFor(() => expect(woken('d-none')).toBe(1));
    expect(woken('d-future')).toBe(0);
  });
});
