// The healer config door must refuse a mode that is not exactly one of its allowed words, and a model id that
// is not text, before writing anything, so a refused body can never leave half of its change saved. The
// dreamer config door stores no mode at all.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-nightly-mode-doors', 'dojo.db'),
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
  seedModel('big', 128_000);
  seedModel('wide', 128_000);
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

describe('the dreamer config door', () => {
  it('stores no mode: a mode sent by an old page is ignored', async () => {
    const res = await vaultRouter.request('/dream/config', json('PUT', { modelId: 'big', dreamMode: 'light' }));
    expect(res.status).toBe(200);
    expect(getConfig('dreaming_mode')).toBeUndefined();
  });
});

describe('the healer mode door', () => {
  it('refuses a mode word that is not allowed and writes nothing', async () => {
    setConfig('healer_mode', 'active');
    setConfig('healer_model_id', 'big');
    const res = await healerRouter.request('/config', json('POST', { modelId: 'wide', healerMode: 'banana' }));
    expect(res.status).toBe(400);
    expect(getConfig('healer_mode')).toBe('active');
    expect(getConfig('healer_model_id')).toBe('big');
  });

  it('refuses a mode that is not text and does not store the model sent with it', async () => {
    const res = await healerRouter.request('/config', json('POST', { modelId: 'big', healerMode: { a: 1 } }));
    expect(res.status).toBe(400);
    expect(getConfig('healer_model_id')).toBeUndefined();
  });

  it('stores each allowed mode word', async () => {
    for (const mode of ['active', 'monitor']) {
      const res = await healerRouter.request('/config', json('POST', { healerMode: mode }));
      expect(res.status).toBe(200);
      expect(getConfig('healer_mode')).toBe(mode);
    }
  });

  it('has no off switch (no sensei agent can be turned off): off is refused', async () => {
    expect((await healerRouter.request('/config', json('POST', { healerMode: 'off' }))).status).toBe(400);
    expect(getConfig('healer_mode')).toBeUndefined();
  });

  it('is not mode-checked when the mode is not being changed', async () => {
    const res = await healerRouter.request('/config', json('POST', { modelId: 'big' }));
    expect(res.status).toBe(200);
  });
});
