// When the model an agent is on is disabled and every other enabled model is under the 32K floor, the agent is
// left with no model (its turn stops on the no-model notice), never moved onto the too-small one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';

const db = (): Database.Database => mockDb.current!;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("DELETE FROM models WHERE id = 'auto'").run();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  const m = db().prepare('INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
  m.run('m-in-use', 'cloud', 'In use', 'in-use', '["chat"]', 200000, 1);
  m.run('m-small', 'cloud', 'Small', 'small', '["chat"]', 8192, 0);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('agent-a', 'A', 'm-in-use', 'idle', '{}')").run();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('disabling a model never lands an agent on a too-small one', () => {
  it('with only a sub-32K model left, the agent has no model', async () => {
    const app = new Hono().route('/config', configRouter);
    const res = await app.request('/config/models/disable', { method: 'POST', body: JSON.stringify({ modelIds: ['m-in-use'] }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'agent-a'").get()).toEqual({ model_id: null });
  });
});
