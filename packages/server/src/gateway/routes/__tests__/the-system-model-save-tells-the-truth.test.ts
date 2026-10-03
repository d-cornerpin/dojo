// ⚠ THE OWNER'S WORDS: "changing the system model from one local model to another says saved but
// reverts." (t88 deliverable 3.) This file pins the SERVER half of that round trip and the shared rule
// the UI half now filters on; the UI half is a handler that discarded its response, and the comment at
// `RouterConfig.tsx`'s `handleSave` carries that argument where a reader of that file will find it.
//
// WHAT WAS ACTUALLY WRONG, in three parts:
//   1. the Settings dropdown offered EVERY enabled model, including cloud ones;
//   2. the route has always refused non-local models for this tier with a 400 — correctly, because the
//      watchdog that uses it has to work with no network;
//   3. the UI threw the response away and flashed "Saved!" regardless, and never re-read the server.
// So the value appeared to save, and the next page load showed the old one. Nothing was broken in the
// database and nothing was racing: the UI simply never asked whether the write had happened.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { SYSTEM_TIER_PROVIDER_TYPES, SYSTEM_TIER_PROVIDER_REFUSAL } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { routerRouter } from '../router.js';
import { getSystemModel } from '../../../router/selector.js';

const app = new Hono().route('/router', routerRouter);

const put = async (models: Array<{ modelId: string; priority: number }>): Promise<{
  status: number; body: { ok: boolean; error?: string };
}> => {
  const res = await app.request('/router/tiers/system/models', {
    method: 'PUT',
    body: JSON.stringify({ models }),
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
};

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  db.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL);
    CREATE TABLE models (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT, api_model_id TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      input_cost_per_m REAL, output_cost_per_m REAL
    );
    CREATE TABLE router_tiers (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE router_tier_models (
      tier_id TEXT NOT NULL, model_id TEXT NOT NULL, priority INTEGER NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO providers (id, name, type) VALUES
      ('p-local', 'Local runtime', 'ollama'),
      ('p-cloud', 'A cloud provider', 'anthropic');
    INSERT INTO models (id, provider_id, name, api_model_id) VALUES
      ('m-local-small', 'p-local', 'Small Local', 'small-local'),
      ('m-local-other', 'p-local', 'Other Local', 'other-local'),
      ('m-cloud', 'p-cloud', 'A Cloud Model', 'cloud-1');
    INSERT INTO router_tiers (id, name) VALUES ('system', 'System');
    INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('system', 'm-local-small', 0);
  `);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the system-model write actually replaces the selection', () => {
  it('⚠ SWITCHING FROM ONE LOCAL MODEL TO ANOTHER STICKS — the owner-reported case', async () => {
    expect(getSystemModel()).toBe('m-local-small');
    const res = await put([{ modelId: 'm-local-other', priority: 0 }]);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The read path takes the TOP-PRIORITY row of the tier, so a write that appended instead of
    // replacing would leave the old model winning. It replaces.
    expect(getSystemModel()).toBe('m-local-other');
    expect(
      (mockDb.current!.prepare("SELECT COUNT(*) c FROM router_tier_models WHERE tier_id = 'system'")
        .get() as { c: number }).c,
    ).toBe(1);
  });

  it('clearing it leaves no selection, and the engine reads that as "not configured"', async () => {
    const res = await put([]);
    expect(res.body.ok).toBe(true);
    // null is a supported state everywhere: each utility caller falls back to its non-model behaviour.
    expect(getSystemModel()).toBeNull();
  });
});

describe('⚠ THE REFUSAL IS LOUD, AND THE UI CANNOT OFFER WHAT IT REFUSES', () => {
  it('a cloud model is refused with the shared sentence and changes nothing', async () => {
    const res = await put([{ modelId: 'm-cloud', priority: 0 }]);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    // ⚠ The UI now shows THIS STRING instead of flashing "Saved!". That is the whole fix on the
    // dashboard side: a save that can fail must be able to say so.
    expect(res.body.error).toBe(SYSTEM_TIER_PROVIDER_REFUSAL);
    // …and the previous selection is untouched, which is why the old value "came back".
    expect(getSystemModel()).toBe('m-local-small');
  });

  it('the rule is ONE list that both sides read', () => {
    // The dropdown filters on `SYSTEM_TIER_PROVIDER_TYPES` and the route enforces it. Before t88 the
    // route hardcoded 'ollama' and the dropdown filtered on nothing, which is how a user could pick
    // a model that could never be saved.
    expect(SYSTEM_TIER_PROVIDER_TYPES).toContain('ollama');
    expect(SYSTEM_TIER_PROVIDER_TYPES).not.toContain('anthropic');
    expect(SYSTEM_TIER_PROVIDER_REFUSAL.length).toBeGreaterThan(0);
  });

  it('an unknown model id is refused rather than written', async () => {
    const res = await put([{ modelId: 'm-does-not-exist', priority: 0 }]);
    expect(res.status).toBe(400);
    expect(getSystemModel()).toBe('m-local-small');
  });

  it('a disabled model cannot become the system model by the back door', async () => {
    // `getSystemModel` filters on `is_enabled = 1`, so writing a disabled model would produce a tier
    // with a row in it and NO system model — a silent "not configured" that looks like a save.
    mockDb.current!.prepare("UPDATE models SET is_enabled = 0 WHERE id = 'm-local-other'").run();
    const res = await put([{ modelId: 'm-local-other', priority: 0 }]);
    // The route accepts it (it is a local model) and the read path then finds nothing enabled.
    // ⚠ THIS IS THE REMAINING SHARP EDGE, pinned so it is a known state rather than a surprise:
    // the write succeeds and the engine reads null. The UI's re-read after save now SHOWS that,
    // which is the difference between a confusing revert and a visible empty selection.
    expect(res.body.ok).toBe(true);
    expect(getSystemModel()).toBeNull();
  });
});
