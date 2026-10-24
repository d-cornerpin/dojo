// v3.5 A5 — THE SYSTEM TIER IS THE DOJO'S WRITER, FIXED. Owner ruling 2026-10-19: the system-model
// pulldown is removed; that job is hard-wired to the small writer. The install routine
// (`services/local-standard.ts`) is the only writer of the tier row; the API refuses it. The summary
// writer (`compaction_model_id`) stays a person's setting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../db/migrations.js';
import { routerRouter } from '../router.js';
import { configRouter } from '../config.js';

const app = new Hono().route('/router', routerRouter).route('/config', configRouter);
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m-local-a', 'ollama-local', 'A', 'a:1', '[\"chat\"]', 32768, 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m-local-b', 'ollama-local', 'B', 'b:1', '[\"chat\"]', 32768, 1)").run();
  db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('system', 'm-local-a', 0)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const put = (path: string, body: unknown): Promise<Response> => Promise.resolve(app.request(path, {
  method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
}));

describe('the system tier cannot be set from the API', () => {
  it('PUT /router/tiers/system/models answers 409 with the plain sentence and changes nothing', async () => {
    const res = await put('/router/tiers/system/models', { models: [{ modelId: 'm-local-b', priority: 0 }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("The Dojo's writer is fixed; it is installed by setup.");
    expect(db().prepare("SELECT model_id FROM router_tier_models WHERE tier_id = 'system'").all()).toEqual([{ model_id: 'm-local-a' }]);
  });

  it('the other tiers are still the owner\'s to set', async () => {
    const res = await put('/router/tiers/light/models', { models: [{ modelId: 'm-local-b', priority: 0 }] });
    expect(res.status).toBe(200);
  });

  it('the summary writer stays a setting: PUT /settings/compaction_model_id still works', async () => {
    const res = await put('/config/settings/compaction_model_id', { value: 'm-local-b' });
    expect(res.status).toBe(200);
    expect(db().prepare("SELECT value FROM config WHERE key = 'compaction_model_id'").get()).toEqual({ value: 'm-local-b' });
  });
});
