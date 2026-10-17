// ════════════════════════════════════════════════════════════════════════════════════
// t195 (D2) — THE THINKING LEVEL: STORED PER MODEL, OFFERED ONLY WHERE THE WIRE TAKES IT.
//
//   * migration 198 adds `models.thinking_level`, default 'high', to a lived-in box and
//     moves no existing row;
//   * `PATCH /models/:id/thinking` sets the level beside the existing toggle, each alone;
//   * the model payload says which levels this model's contract offers (empty: no selector);
//   * a level the contract does not offer is refused, and nothing is stored.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t195-thinking-level');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t195-thinking-level', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-t195-thinking-level', '.dojo');
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated)
             VALUES ('p-native', 'Native', 'openai-compatible', 'https://api.deepseek.com', 'api_key', 1),
                    ('p-generic', 'Generic', 'openai-compatible', 'https://api.example.com/v1', 'api_key', 1)`).run();
  d.prepare(`INSERT INTO models (id, provider_id, api_model_id, name, capabilities, is_enabled)
             VALUES ('m-native', 'p-native', 'deepseek-v4-pro', 'Native', '["text","thinking"]', 1),
                    ('m-generic', 'p-generic', 'some-model', 'Generic', '["text","thinking"]', 1)`).run();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const patch = (id: string, body: unknown): Promise<Response> =>
  configRouter.request(`/models/${id}/thinking`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const data = async (r: Response): Promise<Record<string, unknown>> =>
  ((await r.json()) as Record<string, unknown>).data as Record<string, unknown>;
const row = (id: string): Record<string, unknown> =>
  db().prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;

describe('migration 198 — the column arrives on a lived-in box and nothing else moves', () => {
  it('an existing model reads high after the update, and a later boot does not re-run it', () => {
    // A box from before 198: the column un-done and un-recorded, carrying rows.
    db().exec('ALTER TABLE models DROP COLUMN thinking_level');
    db().prepare('DELETE FROM _migrations WHERE name = ?').run('198_model_thinking_level.sql');
    const before = db().prepare('SELECT id, api_model_id, thinking_enabled, max_output_tokens FROM models ORDER BY id').all();
    runMigrations();
    expect(db().prepare('SELECT id, api_model_id, thinking_enabled, max_output_tokens FROM models ORDER BY id').all()).toEqual(before);
    const all = { n: before.length };
    expect(db().prepare("SELECT COUNT(*) AS n FROM models WHERE thinking_level = 'high'").get()).toEqual(all);
    runMigrations();
    expect(db().prepare("SELECT COUNT(*) AS n FROM models WHERE thinking_level = 'high'").get()).toEqual(all);
  });
});

describe('the level beside the toggle', () => {
  it('a DeepSeek-native model offers its three levels and reads High by default', async () => {
    const res = await patch('m-native', { enabled: true });
    expect(await data(res)).toMatchObject({ thinkingLevel: 'high', thinkingLevels: ['low', 'high', 'max'] });
  });

  it('a model whose wire takes no levels offers none', async () => {
    const res = await patch('m-generic', { enabled: true });
    expect(await data(res)).toMatchObject({ thinkingLevels: [] });
  });

  it('sets the level; the toggle is untouched', async () => {
    await patch('m-native', { enabled: false });
    const res = await patch('m-native', { level: 'max' });
    expect(res.status).toBe(200);
    expect(row('m-native')).toMatchObject({ thinking_level: 'max', thinking_enabled: 0 });
  });

  it('the toggle moves alone too; the level is untouched', async () => {
    await patch('m-native', { level: 'low' });
    await patch('m-native', { enabled: true });
    expect(row('m-native')).toMatchObject({ thinking_level: 'low', thinking_enabled: 1 });
  });

  it('refuses a level this model does not offer, and stores nothing', async () => {
    for (const [id, level] of [['m-native', 'ultra'], ['m-native', 'medium'], ['m-generic', 'high']] as const) {
      const res = await patch(id, { level });
      expect(res.status).toBe(400);
    }
    expect(row('m-native').thinking_level).toBe('high');
    expect(row('m-generic').thinking_level).toBe('high');
  });

  it('refuses an empty or malformed body', async () => {
    for (const body of [{}, { enabled: 'yes' }, { level: 3 }]) {
      expect((await patch('m-native', body)).status).toBe(400);
    }
  });

  it('a missing model is a 404', async () => {
    expect((await patch('nope', { level: 'low' })).status).toBe(404);
  });
});
