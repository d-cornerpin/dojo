// ════════════════════════════════════════════════════════════════════════════════════════
// THE CREATE DOOR STORES A TIMEOUT THE REAPER CAN READ, AND REFUSES WHAT IT CANNOT USE.
//
// The dashboard create route (POST /agents) wrote `timeout_at` as a bare `toISOString()`
// — `2026-10-31T10:00:00.000Z` — while the reaper (`agent/spawner.ts` `checkTimeouts`)
// compares the column against SQLite's `datetime('now')` — `2026-10-31 12:00:00`, a SPACE.
// As text the `T` sorts after the space, so an agent whose limit passed earlier in the UTC
// day was not reaped until the next UTC date: a one-hour limit lasted hours longer. The
// spawner itself writes the space form the comparison needs; this door now writes the same
// one. And what it cannot use it refuses before any write: a timeout that is present but
// not a positive finite number (-5 expired the agent the moment the reaper ran), and a
// name of nothing but spaces (the edit door already skips a blank name; a nameless agent
// must not be minted here either).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t761-timeout-name', 'dojo.db'),
  };
});
const broadcastSpy = vi.fn();
vi.mock('../../ws.js', () => ({
  broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])),
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  isPMAgent: () => false,
  isTrainerAgent: () => false,
  isHealerAgent: () => false,
  isImaginerAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getImaginerAgentId: () => null,
}));
// The create route kicks the fresh agent into a run; the run itself is not under test.
vi.mock('../../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ }, getAgentUptime: () => 0 }),
  stopAgent: vi.fn(),
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';

const db = (): Database.Database => mockDb.current!;

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const agentCount = (): number =>
  (db().prepare('SELECT COUNT(*) n FROM agents').get() as { n: number }).n;

const timeoutAtOf = (name: string): string | null =>
  (db().prepare('SELECT timeout_at FROM agents WHERE name = ?').get(name) as { timeout_at: string | null } | undefined)?.timeout_at ?? null;

beforeEach(() => {
  broadcastSpy.mockClear();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('POST /agents — the timeout form and the blank-name door', () => {
  it('a valid timeout is stored in the space form the reaper compares against', async () => {
    const res = await agentsRouter.request('/', json('POST', { name: 'Scout', systemPrompt: 'x', timeout: 3600 }));
    expect(res.status).toBe(201);
    const at = timeoutAtOf('Scout');
    expect(at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    expect(at).not.toContain('T');
    expect(at).not.toContain('Z');
  });

  it('a negative timeout is refused and creates no agent', async () => {
    const before = agentCount();
    const res = await agentsRouter.request('/', json('POST', { name: 'Runner', systemPrompt: 'x', timeout: -5 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('timeout must be a positive number of seconds');
    expect(agentCount()).toBe(before);
  });

  it('a name of only spaces is refused and creates no agent', async () => {
    const res = await agentsRouter.request('/', json('POST', { name: '   ', systemPrompt: 'x' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('name must not be blank');
    expect(agentCount()).toBe(0);
  });

  it('a non-numeric timeout is refused and creates no agent', async () => {
    const before = agentCount();
    const res = await agentsRouter.request('/', json('POST', { name: 'Echo', systemPrompt: 'x', timeout: 'abc' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('timeout must be a positive number of seconds');
    expect(agentCount()).toBe(before);
  });
});
