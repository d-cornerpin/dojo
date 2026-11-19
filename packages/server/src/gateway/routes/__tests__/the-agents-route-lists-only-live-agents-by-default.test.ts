// GET / listed every agent ever made, so a lived-in box showed about 1,260 ended helpers in
// the Ledger, the task box and the Vault box. It now lists live agents only; ?all=1 adds the
// ended ones for the Agents page's history.

import { it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-roster-live-only', 'dojo.db'),
  };
});
// The GET routes broadcast nothing; the broadcaster is stubbed so the module loads without a socket.
vi.mock('../../ws.js', () => ({
  broadcast: () => {},
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const add = mockDb.current.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)');
  add.run('live-1', 'Live One', 'idle');
  add.run('live-2', 'Live Two', 'paused');
  add.run('gone-1', 'Gone One', 'terminated');
});
afterEach(() => { vi.restoreAllMocks(); mockDb.current?.close(); mockDb.current = null; });

const names = async (path: string): Promise<string[]> =>
  ((await (await agentsRouter.request(path)).json()) as { data: Array<{ name: string }> }).data.map((a) => a.name).sort();

it('lists only live agents by default', async () => {
  expect(await names('/')).toEqual(['Live One', 'Live Two']);
});

it('lists every agent with all=1', async () => {
  expect(await names('/?all=1')).toEqual(['Gone One', 'Live One', 'Live Two']);
});

it('an ended agent can still be read on its own', async () => {
  const res = await agentsRouter.request('/gone-1');
  expect(res.status).toBe(200);
});
