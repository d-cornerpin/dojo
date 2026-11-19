// Re-running setup on an existing agent with a new model writes the model through the one setter, which leaves the change note.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getPMAgentId: () => null,
  getTrainerAgentId: () => null,
  isTrainerAgent: () => false,
}));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';

const db = (): Database.Database => mockDb.current!;
const seedModel = (id: string): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["text","tools"]', 128000, 1024, 1, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('one');
  seedModel('two');
  db().prepare("INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at) VALUES ('first', 'First', 'one', 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('re-running setup on an existing agent', () => {
  it('moves it to the new model and leaves the model-change note', async () => {
    const res = await setupDepsRouter.request('/provision-agent', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'first', name: 'First', modelId: 'two' }),
    });
    expect(res.status).toBe(200);
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'first'").get()).toEqual({ model_id: 'two' });
    const noted = db().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'first' AND role = 'system' AND content LIKE '[System: Model just changed.%'").get() as { n: number };
    expect(noted.n).toBe(1);
  });
});
