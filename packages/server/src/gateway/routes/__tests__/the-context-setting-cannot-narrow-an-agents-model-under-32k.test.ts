// Lowering a model's context setting under the 32K floor is refused, with the floor's own sentence,
// while an agent runs on it; the same change on a model no agent uses is accepted.
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
import { smallMainModelMessage } from '../../../agent/main-model-floor.js';

const app = new Hono().route('/config', configRouter);
const db = (): Database.Database => mockDb.current!;
const setNumCtx = (id: string, override: number | null) => app.request(`/config/models/${id}/num-ctx`, { method: 'PATCH', body: JSON.stringify({ override }), headers: { 'content-type': 'application/json' } });
const overrideOf = (id: string) => (db().prepare('SELECT num_ctx_override FROM models WHERE id = ?').get(id) as { num_ctx_override: number | null }).num_ctx_override;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  const m = db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES (?, 'ollama-local', ?, ?, '[\"chat\",\"tools\"]', 131072, 1)");
  m.run('in-use', 'In use', 'in-use:7b');
  m.run('spare', 'Spare', 'spare:7b');
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('agent-a', 'A', 'in-use', 'idle', '{}')").run();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe("the context setting cannot narrow an agent's model under 32K", () => {
  it('a model an agent runs on: refused with the plain reason, and the row is never written', async () => {
    db().prepare("UPDATE models SET updated_at = '2000-01-01 00:00:00' WHERE id = 'in-use'").run();
    const res = await setNumCtx('in-use', 8_192);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe(smallMainModelMessage('In use', 8_192));
    expect(overrideOf('in-use')).toBeNull();
    expect(db().prepare("SELECT updated_at FROM models WHERE id = 'in-use'").pluck().get()).toBe('2000-01-01 00:00:00');
  });

  it('the same model at or above the floor, and a model no agent uses, are accepted', async () => {
    expect((await setNumCtx('in-use', 32_768)).status).toBe(200);
    expect((await setNumCtx('spare', 8_192)).status).toBe(200);
    expect(overrideOf('spare')).toBe(8_192);
  });
});
