// ════════════════════════════════════════════════════════════════════════════════════
// S07 / F3 — DELETING A PROVIDER CLEARS ITS TIER ROWS.
//
// `DELETE /providers/:id` deletes the provider's models with `PRAGMA foreign_keys = OFF`
// (config.ts:705-708). The models table's own FK to `providers` has ON DELETE CASCADE, but
// `router_tier_models.model_id REFERENCES models(id)` (migration 004) has NO cascade — with
// enforcement off, deleting the models leaves their tier rows behind. Those ghost rows then
// read through `routerWindowFloor` (`src/router/router-window.ts:49-51`) as a still-enabled
// model whose name is a bare uuid, and a later `PUT /api/router/tiers/:tierId/models`
// re-inserts the ghost with FKs back ON, 500ing the whole save.
//
// The single-model delete (`DELETE /models/:id`) already clears the tier rows AND both
// config keys (`pm_agent_model`, `dreaming_model_id`). The provider delete clears only one of those
// keys and never touches the tier rows. This file pins the provider delete to do both, via the
// shared `forgetModelReferences` helper, and pins the `PRAGMA foreign_keys` guard so a throw
// cannot leave enforcement off for the shared connection.
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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-delete-provider-tier');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-delete-provider-tier', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-delete-provider-tier', '.dojo');

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

/**
 * p1 owns m1 and m2, p2 owns m3. m1 and m2 sit in router tiers and m3 sits in one too;
 * two config keys point at p1's models; one agent runs on m1. After p1 is deleted the only
 * tier row left should be m3's, and every reference to m1/m2 — tier rows, config keys,
 * agent pointer — should be gone.
 */
const seed = (): void => {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p1', 'Provider One', 'openai-compatible', 'api_key')").run();
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p2', 'Provider Two', 'openai-compatible', 'api_key')").run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m1', 'p1', 'Model One', 'api-m1', '[]', 32768, 1)
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m2', 'p1', 'Model Two', 'api-m2', '[]', 16384, 1)
  `).run();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m3', 'p2', 'Model Three', 'api-m3', '[]', 8192, 1)
  `).run();
  db.prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('standard', 'm1', 0)").run();
  db.prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('standard', 'm3', 1)").run();
  db.prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('light', 'm2', 0)").run();
  db.prepare("INSERT INTO config (key, value) VALUES ('dreaming_model_id', 'm1')").run();
  db.prepare("INSERT INTO config (key, value) VALUES ('pm_agent_model', 'm2')").run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a1', 'Agent One', 'm1', 'terminated', '{}')").run();
};

const tierModelIds = (): string[] =>
  mockDb.current!.prepare('SELECT model_id FROM router_tier_models').all().map((r) => (r as { model_id: string }).model_id);

describe('S07/F3 — deleting a provider clears its tier rows and model references', () => {
  beforeEach(() => seed());

  it('removes the provider\'s models from every router tier, leaving only the other provider\'s row', async () => {
    const res = await del('/providers/p1');
    expect(res.status).toBe(200); // without this the case passes when the route is absent
    expect(tierModelIds()).toEqual(['m3']);
  });

  it("clears the config keys that pointed at its models, and nulls a terminated agent's pointer", async () => {
    const res = await del('/providers/p1');
    expect(res.status).toBe(200);
    expect(mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get('dreaming_model_id')).toBeUndefined();
    expect(mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get('pm_agent_model')).toBeUndefined();
    expect(mockDb.current!.prepare('SELECT model_id FROM agents WHERE id = ?').get('a1')).toEqual({ model_id: null });
  });

  it('leaves foreign-key enforcement back on for the shared connection', async () => {
    const res = await del('/providers/p1');
    expect(res.status).toBe(200);
    expect(mockDb.current!.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('restores foreign-key enforcement even when the delete itself throws', async () => {
    // A BEFORE DELETE trigger that aborts makes `DELETE FROM providers` throw, so the
    // FK-off/delete/FK-on sequence cannot complete. The finally guard must still switch
    // enforcement back on for the shared connection.
    mockDb.current!.exec(`
      CREATE TRIGGER no_del BEFORE DELETE ON providers
      BEGIN SELECT RAISE(ABORT, 'no'); END;
    `);
    const res = await del('/providers/p1');
    expect(res.status).toBe(500);
    expect(mockDb.current!.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('CONTROL: the single-model delete still removes its tier row', async () => {
    const res = await del('/models/m3');
    expect(res.status).toBe(200);
    // m3's row is gone; the rows for p1's models are untouched by the model delete.
    expect(tierModelIds().sort()).toEqual(['m1', 'm2']);
  });
});
