// A provider whose models are the only ones the agents can run on is not deleted, and nothing is moved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// The platform resolves `~/.dojo` in one place, `src/home.ts`; a test redirects that one place.
vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-only-usable-provider');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const REFUSAL = "This provider's models are the only ones your agents can run on. Add another model first, then delete this one.";
const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, caps: string): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled)
    VALUES (?, ?, ?, ?, ?, 128000, 1, 1)`).run(id, provider, `Model ${id}`, id, caps);
};
const del = (p: string): Promise<Response> => configRouter.request(p, { method: 'DELETE' });

beforeEach(() => {
  clearSecretsCache();
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p1', 'Provider One', 'openai-compatible', 'api_key')").run();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p2', 'Provider Two', 'openai-compatible', 'api_key')").run();
  model('m1', 'p1', '["text","tools"]');
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a1', 'Agent One', 'm1', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const untouched = (): void => {
  expect(db().prepare("SELECT model_id FROM agents WHERE id = 'a1'").get()).toEqual({ model_id: 'm1' });
  expect(db().prepare("SELECT COUNT(*) AS n FROM providers WHERE id = 'p1'").get()).toEqual({ n: 1 });
  expect(db().prepare("SELECT COUNT(*) AS n FROM models WHERE id = 'm1'").get()).toEqual({ n: 1 });
};

describe('deleting a provider whose models are the only ones that can run an agent', () => {
  it('is refused with no other model, and nothing is moved or deleted', async () => {
    const res = await del('/providers/p1');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
    untouched();
  });
  it('is refused when the only other model cannot call tools', async () => {
    model('m2', 'p2', '["text"]');
    const res = await del('/providers/p1');
    expect(res.status).toBe(409);
    untouched();
  });
  it('goes ahead when another model can take the agents', async () => {
    model('m2', 'p2', '["text","tools"]');
    expect((await del('/providers/p1')).status).toBe(200);
    expect(db().prepare("SELECT model_id FROM agents WHERE id = 'a1'").get()).toEqual({ model_id: 'm2' });
  });
});
