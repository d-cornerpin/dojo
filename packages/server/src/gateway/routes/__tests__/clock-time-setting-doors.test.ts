// The three doors that store a daily run time — the healer config setter, the dreamer
// config setter and the generic settings key setter — must refuse a value that is not a
// 24-hour H:MM / HH:MM, before writing anything, so a time like "9am" or "25:00" can
// never reach the daily schedule.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-clock-time-doors', 'dojo.db'),
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
import { refuseBadClockTime } from '../../../config/clock-time.js';
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

describe('refuseBadClockTime', () => {
  it('accepts a valid 24-hour daily run time', () => {
    for (const t of ['04:00', '4:00', '00:00', '23:59']) {
      expect(refuseBadClockTime(t)).toBeNull();
    }
  });

  it('refuses anything that is not a 24-hour daily run time', () => {
    for (const bad of ['24:00', '12:60', '9am', '4', '', '04:00:00', ' 04:00', null, undefined, 400]) {
      expect(typeof refuseBadClockTime(bad as unknown)).toBe('string');
    }
  });
});

describe('the healer door', () => {
  it('refuses a bad time and writes nothing', async () => {
    const res = await healerRouter.request('/config', json('POST', { healerTime: '25:00' }));
    expect(res.status).toBe(400);
    expect(getConfig('healer_time')).toBeUndefined();
  });

  it('accepts a good time and stores it', async () => {
    const res = await healerRouter.request('/config', json('POST', { healerTime: '05:30' }));
    expect(res.status).toBe(200);
    expect(getConfig('healer_time')).toBe('05:30');
  });

  it('is not time-checked when the time is not being changed', async () => {
    const res = await healerRouter.request('/config', json('POST', { modelId: 'big' }));
    expect(res.status).toBe(200);
  });
});

describe('the dreamer door', () => {
  it('refuses a bad time and writes nothing', async () => {
    const res = await vaultRouter.request('/dream/config', json('PUT', { dreamTime: '9am' }));
    expect(res.status).toBe(400);
    expect(getConfig('dreaming_time')).toBeUndefined();
  });

  it('accepts a good time and stores it', async () => {
    const res = await vaultRouter.request('/dream/config', json('PUT', { dreamTime: '03:15' }));
    expect(res.status).toBe(200);
    expect(getConfig('dreaming_time')).toBe('03:15');
  });
});

describe('the generic settings key setter', () => {
  it('refuses a bad time for a time key', async () => {
    const res = await configRouter.request('/settings/healer_time', json('PUT', { value: '12:60' }));
    expect(res.status).toBe(400);
  });

  it('accepts a good time for a time key', async () => {
    const res = await configRouter.request('/settings/dreaming_time', json('PUT', { value: '02:00' }));
    expect(res.status).toBe(200);
    expect(getConfig('dreaming_time')).toBe('02:00');
  });

  it('leaves other keys untouched by the time check', async () => {
    const res = await configRouter.request('/settings/some_other_key', json('PUT', { value: '12:60' }));
    expect(res.status).toBe(200);
  });
});
