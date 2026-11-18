// ════════════════════════════════════════════════════════════════════════════════════
// A FRESH BOX CAPS EVERYDAY ANSWERS.
//
// `POST /providers` seeds both DeepSeek reference models from the `DEEPSEEK_MODELS`
// table (config.ts) straight into `models.max_output_tokens`, which is the per-request
// cap every call asks for. Seeded at the provider's own 384K ceiling, one answer that
// grinds on holds an agent busy for many minutes. The seed should carry the everyday
// 32K cap; the extra room up to the contract ceiling (`DEEPSEEK_MAX_OUTPUT_TOKENS`,
// `src/agent/model-contract.ts`) is a model-contract figure a cut-off call may get once,
// not what a fresh box seeds.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

// The platform resolves `~/.dojo` in exactly one place — `src/home.ts` — so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
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

const send = (method: string, p: string, body?: unknown): Promise<Response> =>
  configRouter.request(p, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('a fresh box caps everyday answers', () => {
  it('a newly added DeepSeek provider caps everyday answers at 32,000', async () => {
    // No credential is sent, so the seed skips the live /models fetch and makes no network call.
    const res = await send('POST', '/providers', {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      authType: 'api_key',
    });
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
