// The two model lists the dashboard pickers read say why a model cannot run an agent in `notForAgents`;
// a picture model is told apart from a small one.

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
import { configRouter } from '../config.js';
import { routerRouter } from '../router.js';
import * as coldImport1 from '../../../config/platform.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, window: number | null, caps = '["chat"]'): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, ?, ?, 1024, 1, datetime('now'), datetime('now'))
  `).run(id, `Model ${id}`, id, caps, window);
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

beforeEach(async () => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1, datetime('now'), datetime('now'))
  `).run();
  seedModel('big', 128_000);
  seedModel('tiny', 8_192);
  seedModel('video', 128_000, '["video_generation"]');
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

type Row = { id: string; notForAgents?: string | null };
const rowById = (rows: Row[], id: string): Row | undefined => rows.find((r) => r.id === id);

describe('the model lists say why a model cannot run an agent', () => {
  it('the settings model list names each reason', async () => {
    const res = await configRouter.request('/models');
    const rows = ((await res.json()) as { data: Row[] }).data;
    expect(rowById(rows, 'big')?.notForAgents).toBeNull();
    expect(rowById(rows, 'tiny')?.notForAgents).toBe('too small for an agent');
    expect(rowById(rows, 'video')?.notForAgents).toBe('not a chat model');
  });

  it("the router's model list names the small one", async () => {
    const res = await routerRouter.request('/available-models');
    const rows = ((await res.json()) as { data: Row[] }).data;
    expect(rowById(rows, 'tiny')?.notForAgents).toBe('too small for an agent');
    expect(rowById(rows, 'big')?.notForAgents).toBeNull();
  });
});
