// THE VITALS PAGE COUNTS ONLY LIVE AGENTS.
//
// The health read counted every row the agents table ever held, so a box with 8 live
// agents said "Agents 1269". Ended agents are history, not load. The count must skip
// rows whose status is 'terminated'.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-vitals-live-count', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({
  broadcast: vi.fn(),
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { systemRouter } from '../system.js';

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  const add = mockDb.current.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)');
  add.run('a1', 'Agent One', 'idle');
  add.run('a2', 'Agent Two', 'working');
  add.run('g1', 'Gone One', 'terminated');
  add.run('g2', 'Gone Two', 'terminated');
  add.run('g3', 'Gone Three', 'terminated');
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the health read counts only live agents', () => {
  it('counts the two live agents and none of the three ended ones', async () => {
    const res = await systemRouter.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { agents: number } };
    expect(body.data.agents).toBe(2);
  });
});
