// ════════════════════════════════════════════════════════════════════════════════════════
// The Settings "Test Router" box asks `decideTier`, the one function real turns use, so it
// shows the tier a turn with this prompt would really get and the method that decided it:
// the meaning classifier when the embedder is up, the keyword backup when it is down.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-r29-router-test', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

const sem = vi.hoisted(() => ({ next: null as null | { tier: 'light' | 'standard' | 'heavy'; confidence: number; topScore: number; scores: Record<string, number>; headVersion: string } }));
vi.mock('../../../router/semantic.js', async (orig) => ({
  ...(await orig<typeof import('../../../router/semantic.js')>()),
  classifyTierSemantic: async () => sem.next,
}));

import { runMigrations } from '../../../db/migrations.js';
import { routerRouter } from '../router.js';
import { scoreQuery } from '../../../router/scorer.js';

const post = (prompt: string) => routerRouter.request('/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
type Data = { tier: string; method: string; scores: unknown[] };

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  sem.next = null;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the router test box shows the decision a turn would get', () => {
  it('with the embedder ready the box shows the meaning decision', async () => {
    sem.next = { tier: 'heavy', confidence: 0.9, topScore: 0.8, scores: { light: 0.1, standard: 0.2, heavy: 0.8 }, headVersion: 'centroid-1' };
    const res = await post('hi');
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: Data }).data;
    expect(d.method).toBe('semantic');
    expect(d.tier).toBe('heavy');
    expect(d.scores).toEqual([]);
  });

  it('with the embedder down the box shows the keyword backup', async () => {
    sem.next = null;
    const res = await post('hi');
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: Data }).data;
    expect(d.method).toBe('fallback');
    expect(d.tier).toBe(scoreQuery('', [{ role: 'user', content: 'hi' }]).tier);
  });
});
