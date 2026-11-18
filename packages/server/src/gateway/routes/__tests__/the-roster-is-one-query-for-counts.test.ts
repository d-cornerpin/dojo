// GET / used to read message counts and model rows once PER ROW: a roster of N agents cost
// 2N queries on every Ledger reload. The roster now reads all counts in one grouped query and
// all model rows in one query, whatever the number of rows.

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-roster-one-query', 'dojo.db'),
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
  const db = mockDb.current;
  db.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('prov-r', 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('model-r', 'prov-r', 'Roster Model', 'api/roster', '[]', 1)`).run();
  for (const [id, n] of [['ag-1', 3], ['ag-2', 0], ['ag-3', 1], ['ag-4', 2], ['ag-5', 0]] as const) {
    db.prepare(`INSERT INTO agents (id, name, status, model_id) VALUES (?, ?, 'idle', 'model-r')`).run(id, `Agent ${id}`);
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO messages (id, agent_id, role, content, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`${id}-m${i}`, id, 'user', 'hello', Date.now(), 1);
    }
  }
});
afterEach(() => { vi.restoreAllMocks(); mockDb.current?.close(); mockDb.current = null; });

it('reads every message count with one query and every model with one query', async () => {
  const prepare = vi.spyOn(mockDb.current!, 'prepare');
  const res = await agentsRouter.request('/');
  expect(res.status).toBe(200);
  const sql = prepare.mock.calls.map(([s]) => String(s));
  expect(sql.filter((s) => /FROM messages\b/.test(s))).toHaveLength(1);
  expect(sql.filter((s) => /FROM models\b/.test(s))).toHaveLength(1);
});

it('each agent still carries its own message count and its model', async () => {
  const body = await (await agentsRouter.request('/')).json() as { ok: boolean; data: Array<{ id: string; messageCount: number; model: { name: string } | null }> };
  const byId = new Map(body.data.map((a) => [a.id, a]));
  expect(byId.get('ag-1')?.messageCount).toBe(3);
  expect(byId.get('ag-2')?.messageCount).toBe(0);
  expect(byId.get('ag-4')?.messageCount).toBe(2);
  expect(byId.get('ag-3')?.model?.name).toBe('Roster Model');
});

it('one agent read alone still has its count', async () => {
  const body = await (await agentsRouter.request('/ag-1')).json() as { data: { messageCount: number; model: { name: string } | null } };
  expect(body.data.messageCount).toBe(3);
  expect(body.data.model?.name).toBe('Roster Model');
});
