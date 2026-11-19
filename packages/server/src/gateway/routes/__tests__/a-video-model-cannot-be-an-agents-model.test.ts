// A model that is not a chat model cannot run an agent: every door that sets an agent's model refuses it in plain words,
// the automatic pick skips it, and re-saving the model an agent is already on is never refused.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { healerRouter } from '../healer.js';
import { configRouter } from '../config.js';
import { agentsHandlers } from '../../../agent/tools/cat/agents.js';
import * as coldImport1 from '../../../config/platform.js';
import { cheapestAgentModel } from '../../../agent/main-model-floor.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, caps: string, cost: number | null = 1, provider = 'local', apiId = id): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 128000, 1024, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(id, provider, `Model ${id}`, apiId, caps, cost, cost);
};
const seedAgent = (id: string, modelId: string, parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'idle', '{}', 0, ?, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, modelId, parent);
};
const setConfig = (k: string, v: string): void => {
  db().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
};
const getConfig = (k: string): string | undefined =>
  (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const modelOf = (id: string): string | null =>
  (db().prepare('SELECT model_id FROM agents WHERE id = ?').get(id) as { model_id: string | null } | undefined)?.model_id ?? null;
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))
  `).run();
  seedModel('big', '["chat","tools"]');
  seedModel('video', '["vision","video_generation"]', 0);
  seedModel('decider', '["decision"]', 0);
  setConfig('primary_agent_id', 'main-agent');
  setConfig('healer_agent_id', 'healer-agent');
  setConfig('dreamer_agent_id', 'dreamer-agent');
  seedAgent('main-agent', 'big');
  seedAgent('healer-agent', 'big');
  seedAgent('dreamer-agent', 'big');
  coldImport1.clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const NOT_CHAT = /not a chat model/;

describe('a model that is not a chat model cannot run an agent', () => {
  it('the settings door refuses a video model for the Healer and writes nothing', async () => {
    const res = await configRouter.request('/settings/healer_model_id', json('PUT', { value: 'video' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(NOT_CHAT);
    expect(getConfig('healer_model_id')).toBeUndefined();
    expect(modelOf('healer-agent')).toBe('big');
  });

  it('the update_agent tool refuses the decision model', async () => {
    seedAgent('worker', 'big', 'main-agent');
    const out = await agentsHandlers['update_agent']!({
      agentId: 'main-agent', args: { agent_id: 'worker', model_id: 'decider' },
    } as never);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(NOT_CHAT);
    expect(modelOf('worker')).toBe('big');
  });

  it('re-saving the model an agent is already on is never refused', async () => {
    db().prepare("UPDATE agents SET model_id = 'video' WHERE id = 'healer-agent'").run();
    const res = await healerRouter.request('/config', json('POST', { modelId: 'video' }));
    expect(res.status).toBe(200);
  });

  it('the automatic pick skips the Dojo\'s own writer', () => {
    db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
      VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1, datetime('now'), datetime('now'))`).run();
    seedModel('writer', '["chat"]', 0, 'ollama-local', 'qwen3.5:4b');
    expect(cheapestAgentModel()).toBe('big');
  });

  it('the automatic pick never takes a free video model', () => {
    expect(cheapestAgentModel()).toBe('big');
  });
});
