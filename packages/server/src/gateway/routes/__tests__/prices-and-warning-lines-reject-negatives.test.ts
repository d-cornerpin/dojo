// 767: prices and the low-balance line refuse negative numbers, and a refused save keeps nothing.
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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-767-negatives');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-767-negatives', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-767-negatives', '.dojo');

beforeEach(() => {
  fs.rmSync(path.join(FAKE_DOJO, 'secrets.yaml'), { force: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type, is_validated)
     VALUES ('local-ds4', 'Local DS4', 'openai-compatible', 'http://127.0.0.1:8123/v1', 'none', 1)`,
  ).run();
  // The browse-added shape, verbatim: both limits NULL.
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, input_cost_per_m, output_cost_per_m, is_enabled)
     VALUES ('m-local', 'local-ds4', 'ds4', 'DS4 Local', 5, 7, 1)`,
  ).run();
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

const row = (): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM models WHERE id = ?').get('m-local') as Record<string, unknown>;


const thresholdRow = (key: string): unknown =>
  mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(key);

describe('767 — negative prices and warning lines are refused', () => {
  it('a negative input price is a 400 and nothing is stored', async () => {
    const res = await send('PUT', '/models/m-local/pricing', { inputCostPerM: -1 });
    expect(res.status).toBe(400);
    expect(row().input_cost_per_m).toBe(5);
  });

  it('a negative cost per unit refuses the whole save, not half of it', async () => {
    const res = await send('PUT', '/models/m-local/pricing', { inputCostPerM: 2, costPerUnit: -3 });
    expect(res.status).toBe(400);
    expect(row().input_cost_per_m).toBe(5);
  });

  it('zero and positive prices save', async () => {
    const res = await send('PUT', '/models/m-local/pricing', { inputCostPerM: 0, outputCostPerM: 1.5 });
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ input_cost_per_m: 0, output_cost_per_m: 1.5 });
  });

  it.each(['/openrouter/threshold', '/deepseek/threshold'])('%s refuses a negative line and writes nothing', async (p) => {
    const res = await send('POST', p, { threshold: -5 });
    expect(res.status).toBe(400);
    expect(thresholdRow(`${p.split('/')[1]}_warning_threshold`)).toBeUndefined();
  });

  it.each(['/openrouter/threshold', '/deepseek/threshold'])('%s accepts zero', async (p) => {
    const res = await send('POST', p, { threshold: 0 });
    expect(res.status).toBe(200);
  });
});
