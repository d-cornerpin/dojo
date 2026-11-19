// Choosing a model for the PM on the agent card also sets the PM's model setting, as every model door does.
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

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';

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
  db().prepare("INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at) VALUES ('pm', 'PM', 'one', 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the agent card model picker', () => {
  it('moves the PM to the chosen model and sets the PM model setting too', async () => {
    const res = await agentsRouter.request('/pm/model', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelId: 'two' }),
    });
    expect(res.status).toBe(200);
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'pm'").get()).toEqual({ model_id: 'two' });
    expect(db().prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get()).toEqual({ value: 'two' });
  });
});
