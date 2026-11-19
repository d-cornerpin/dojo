// A model set with update_agent goes through the one setter, so a turn parked for lack of a fitting model is looked at again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../../db/migrations.js';
import * as platform from '../../../../config/platform.js';
import * as honestStopLock from '../../../v2/honest-stop-lock.js';
import { agentsHandlers } from '../agents.js';

const db = (): Database.Database => mockDb.current!;
const seedModel = (id: string): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["chat","tools"]', 128000, 1024, 1, 1, 1, datetime('now'), datetime('now'))`).run(id, `Model ${id}`, id);
};
const seedAgent = (id: string, parent: string | null): void => {
  db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, 'big', 'idle', '{}', 0, ?, 'owner', datetime('now'), datetime('now'))`).run(id, id, parent);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at) VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))").run();
  seedModel('big');
  seedModel('big2');
  db().prepare("INSERT INTO config (key, value, updated_at) VALUES ('primary_agent_id', 'main-agent', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run();
  seedAgent('main-agent', null);
  seedAgent('worker', 'main-agent');
  platform.clearPlatformConfigCache();
});
afterEach(() => { vi.restoreAllMocks(); mockDb.current?.close(); mockDb.current = null; });

describe('update_agent and a new model', () => {
  it('writes the model and looks again at the agent through the one setter', async () => {
    const looked = vi.spyOn(honestStopLock, 'noteModelsChanged').mockResolvedValue();
    const out = await agentsHandlers['update_agent']!({ agentId: 'main-agent', args: { agent_id: 'worker', model_id: 'big2' } } as never);
    expect(out.isError).toBeFalsy();
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'worker'").get()).toEqual({ model_id: 'big2' });
    expect(looked).toHaveBeenCalledWith('worker');
  });
});
