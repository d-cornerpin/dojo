// ════════════════════════════════════════════════════════════════════════════════════
// DELETING A PROVIDER MOVES ITS AGENTS TO A WORKING MODEL.
//
// `DELETE /providers/:id` used to null every agent's model_id and clear only two config
// keys, so each agent on a deleted model showed "no model" until the owner picked one, and
// the service-agent settings could still name a deleted model. The delete now runs the one
// mover `reassignAffectedAgents` (agents and the service-agent model settings move to the
// cheapest working model with the usual "model changed" note; with none, they are left
// without a model as before), forgets every key of `LOCAL_MODEL_SETTING_KEYS`, and refuses
// to delete the provider that holds the Dojo's own two standard models.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

// The platform resolves `~/.dojo` in exactly one place, `src/home.ts`, so that is
// what a test redirects. Computed inside the factory, which runs before this module's
// own bindings initialise.
vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-r27-delete-provider-moves');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-r27-delete-provider-moves', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-r27-delete-provider-moves', '.dojo');

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

const del = (p: string): Promise<Response> => send('DELETE', p);

const db = () => mockDb.current!;
const model = (id: string, provider: string, window: number, cost: number, apiId = id): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, '["chat"]', ?, ?, 1)`).run(id, provider, `Model ${id}`, apiId, window, cost);
};
const cfg = (k: string): string | undefined => (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value;

describe('deleting a provider moves its agents to a working model', () => {
  it('the agents on a deleted provider move to a working model with a note', async () => {
    db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p1', 'Provider One', 'openai-compatible', 'api_key')").run();
    db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p2', 'Provider Two', 'openai-compatible', 'api_key')").run();
    model('m1', 'p1', 64000, 2);
    model('m2', 'p2', 128000, 1);
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a1', 'Agent One', 'm1', 'idle', '{}')").run();
    db().prepare("INSERT INTO config (key, value) VALUES ('dreaming_model_id', 'm1')").run();
    db().prepare("INSERT INTO config (key, value) VALUES ('healer_model_id', 'm1')").run();

    const res = await del('/providers/p1');
    expect(res.status).toBe(200);
    expect(db().prepare('SELECT model_id FROM agents WHERE id = ?').get('a1')).toEqual({ model_id: 'm2' });
    expect(cfg('dreaming_model_id')).toBe('m2');
    expect(cfg('healer_model_id')).toBe('m2');
    const noted = db().prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'a1' AND role = 'system' AND content LIKE '[System: Model just changed.%'",
    ).get() as { n: number };
    expect(noted.n).toBe(1);
  });

  it('with no working model left, every setting that named it is cleared', async () => {
    db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p1', 'Provider One', 'openai-compatible', 'api_key')").run();
    model('m1', 'p1', 64000, 2);
    db().prepare("INSERT INTO config (key, value) VALUES ('healer_model_id', 'm1')").run();
    db().prepare("INSERT INTO config (key, value) VALUES ('trainer_agent_model', 'm1')").run();

    const res = await del('/providers/p1');
    expect(res.status).toBe(200);
    expect(cfg('healer_model_id')).toBeUndefined();
    expect(cfg('trainer_agent_model')).toBeUndefined();
  });

  it("the provider that holds the Dojo's own models is kept", async () => {
    db().prepare(`
      INSERT INTO providers (id, name, type, base_url, auth_type, created_at, updated_at)
      VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', datetime('now'), datetime('now'))
    `).run();
    model('writer', 'ollama-local', 262144, 0, 'qwen3.5:4b');

    const res = await del('/providers/ollama-local');
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.error).toBe('The Dojo itself runs on a model from this provider for memory summaries and quick checks, so this provider stays.');
    const left = db().prepare("SELECT COUNT(*) AS n FROM providers WHERE id = 'ollama-local'").get() as { n: number };
    expect(left.n).toBe(1);
  });
});
