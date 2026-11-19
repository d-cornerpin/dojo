// An agent moved off a removed model goes through the one setter, so its role's model setting follows it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { reassignAffectedAgents } from '../main-model-floor.js';

const db = (): Database.Database => mockDb.current!;
const seedModel = (id: string, cost: number): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, 'p', ?, ?, '["text","tools"]', 128000, 1024, ?, 1, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id, cost);
};
const seedAgent = (id: string, modelId: string): void => {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', 0, 'owner', datetime('now'), datetime('now'))`).run(id, id, modelId);
};
const modelOf = (id: string): string | null => (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string | null }).model_id;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('p', 'P', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('gone', 1);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('moving agents off a model', () => {
  it('the PM moves to the cheapest other model and its model setting follows', async () => {
    seedModel('cheap', 2);
    seedAgent('pm', 'gone');
    expect(await reassignAffectedAgents(['gone'])).toEqual({ agentsMoved: 1, agentsWithoutModel: 0 });
    expect(modelOf('pm')).toBe('cheap');
    expect((db().prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string }).value).toBe('cheap');
  });
  it('with no other model the agent is left without one and counted', async () => {
    seedAgent('helper', 'gone');
    expect(await reassignAffectedAgents(['gone'])).toEqual({ agentsMoved: 0, agentsWithoutModel: 1 });
    expect(modelOf('helper')).toBeNull();
  });
});
