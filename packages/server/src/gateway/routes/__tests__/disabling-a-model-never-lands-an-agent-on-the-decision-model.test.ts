// v3.5 fix round 2 (d) — DISABLING MODELS NEVER MOVES AN AGENT ONTO THE DOJO'S DECISION MODEL. When a
// model is disabled its agents move to the cheapest enabled text model that clears the 32K floor; the
// decision model (cost 0, a 256K window) answers yes/no questions and must never be that model.
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
import { STANDARD_DECISION_MODEL } from '../../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("DELETE FROM models WHERE id = 'auto'").run();   // so the cost-0 decision model is the cheapest candidate
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', 'api_key', 1)").run();
  const m = db().prepare('INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
  m.run('ollama-tev1-4b-q4-K-M', 'ollama-local', STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag, '["decision"]', 262144, 0);
  m.run('m-in-use', 'cloud', 'In use', 'in-use', '["chat"]', 200000, 1);
  m.run('m-next', 'cloud', 'Next', 'next', '["chat"]', 200000, 3);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('agent-a', 'A', 'm-in-use', 'idle', '{}')").run();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('disabling the model an agent is on', () => {
  it('moves it to the next text model, never to the decision model', async () => {
    const app = new Hono().route('/config', configRouter);
    const res = await app.request('/config/models/disable', { method: 'POST', body: JSON.stringify({ modelIds: ['m-in-use'] }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'agent-a'").get()).toEqual({ model_id: 'm-next' });
  });
});
