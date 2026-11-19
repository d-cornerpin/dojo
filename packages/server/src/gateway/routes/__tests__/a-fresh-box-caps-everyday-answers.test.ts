// A newly added DeepSeek provider seeds both reference models with the everyday 32,000 output cap, not the provider ceiling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-r27-fresh-cap');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-r27-fresh-cap', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-r27-fresh-cap', '.dojo');

beforeEach(() => {
  fs.rmSync(path.join(FAKE_DOJO, 'secrets.yaml'), { force: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a fresh box caps everyday answers', () => {
  it('a newly added DeepSeek provider caps everyday answers at 32,000', async () => {
    // No credential is sent, so the seed skips the live /models fetch and makes no network call.
    const res = await configRouter.request('/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      authType: 'api_key',
    }) });
    expect(res.status).toBe(201); // without this the case passes when the route is absent
    const caps = mockDb.current!
      .prepare("SELECT api_model_id, max_output_tokens FROM models WHERE provider_id = 'deepseek' ORDER BY api_model_id")
      .all();
    expect(caps).toEqual([
      { api_model_id: 'deepseek-v4-flash', max_output_tokens: 32000 },
      { api_model_id: 'deepseek-v4-pro', max_output_tokens: 32000 },
    ]);
  });
});
