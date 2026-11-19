import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-r27-one-setter', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({
  enforceModelCapabilities: vi.fn(),
  injectAttachmentBlocks: vi.fn(),
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));

import { runMigrations } from '../../../db/migrations.js';
import { healerRouter } from '../healer.js';
import { vaultRouter } from '../vault.js';
import { configRouter } from '../config.js';
import * as coldImport1 from '../../../config/platform.js';

const db = (): Database.Database => mockDb.current!;

const seedModel = (id: string, window: number | null): void => {
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, 'local', ?, ?, '["text"]', ?, 1024, 1, datetime('now'), datetime('now'))
  `).run(id, `Model ${id}`, id, window);
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
const notes = (id: string): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND role = 'system' AND content LIKE '[System: Model just changed.%'").get(id) as { n: number }).n;

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
  seedModel('big2', 128_000);
  seedModel('tiny', 8_192);
  seedModel('unknown', null);
  setConfig('primary_agent_id', 'main-agent');
  setConfig('healer_agent_id', 'healer-agent');
  setConfig('dreamer_agent_id', 'dreamer-agent');
  setConfig('pm_agent_id', 'pm-agent');
  seedAgent('main-agent', 'big');
  seedAgent('healer-agent', 'big');
  seedAgent('dreamer-agent', 'big');
  seedAgent('pm-agent', 'big');
  coldImport1.clearPlatformConfigCache();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('one model setter writes the row, the note and the parked-turn look for every model door', () => {
  it('the Settings door moves the Healer and writes the change note', async () => {
    const res = await configRouter.request('/settings/healer_model_id', json('PUT', { value: 'big2' }));
    expect(res.status).toBe(200);
    expect(modelOf('healer-agent')).toBe('big2');
    expect(notes('healer-agent')).toBe(1);
  });

  it('the Healer door writes the change note', async () => {
    const res = await healerRouter.request('/config', json('POST', { modelId: 'big2' }));
    expect(res.status).toBe(200);
    expect(modelOf('healer-agent')).toBe('big2');
    expect(notes('healer-agent')).toBe(1);
  });

  it('the Dreamer door writes the change note', async () => {
    const res = await vaultRouter.request('/dream/config', json('PUT', { modelId: 'big2' }));
    expect(res.status).toBe(200);
    expect(modelOf('dreamer-agent')).toBe('big2');
    expect(notes('dreamer-agent')).toBe(1);
  });

  it('the project manager setting moves the project manager', async () => {
    const res = await configRouter.request('/settings/pm_agent_model', json('PUT', { value: 'big2' }));
    expect(res.status).toBe(200);
    expect(modelOf('pm-agent')).toBe('big2');
    expect(notes('pm-agent')).toBe(1);
  });

  it('re-saving the same model writes no note', async () => {
    const res = await configRouter.request('/settings/healer_model_id', json('PUT', { value: 'big' }));
    expect(res.status).toBe(200);
    expect(notes('healer-agent')).toBe(0);
  });

  it('an empty value moves no agent', async () => {
    const res = await configRouter.request('/settings/healer_model_id', json('PUT', { value: '' }));
    expect(res.status).toBe(200);
    expect(modelOf('healer-agent')).toBe('big');
  });
});
