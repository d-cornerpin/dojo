// ════════════════════════════════════════════════════════════════════════════════════════
// Rulings audit #14 (M5). The owner: "Block below 32K, say why" / "anything under 32k simply wouldn't be selectable for
// an agent." Every fixed-model door held the floor, but the router's tiers took an 8K model, and every automatic agent
// then ran at that model's window. Now: an agent tier refuses a model ADDED under 32K with the floor's own sentence.
// A small model already on a tier is kept, as at every other main-model door (re-saving is never refused); the router
// window's own honest stop and card (N42) already name it as the cause when it is too small for an agent.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../../db/migrations.js';
import { routerRouter } from '../router.js';
import { smallMainModelMessage } from '../../../agent/main-model-floor.js';

const app = new Hono().route('/router', routerRouter);
const db = (): Database.Database => mockDb.current!;
const model = (id: string, name: string, window: number, numCtx: number | null = null): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, num_ctx_override, is_enabled)
    VALUES (?, 'cloud', ?, ?, '["chat"]', ?, ?, 1)`).run(id, name, id, window, numCtx);
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'openai', 'https://api.example.com/v1', 'api_key', 1)").run();
  model('big', 'Big', 128_000);
  model('small', 'Small', 8_192);
  model('narrowed', 'Narrowed', 128_000, 16_384);
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const put = (tier: string, ids: string[]): Promise<Response> => Promise.resolve(app.request(`/router/tiers/${tier}/models`, {
  method: 'PUT', body: JSON.stringify({ models: ids.map((modelId, priority) => ({ modelId, priority })) }), headers: { 'content-type': 'application/json' },
}));

describe('an agent tier takes no model under the 32K floor', () => {
  it('adding an 8K model to the light tier is refused with the floor\'s own sentence; nothing is written', async () => {
    const res = await put('light', ['big', 'small']);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(smallMainModelMessage('Small', 8_192));
    expect(db().prepare("SELECT model_id FROM router_tier_models WHERE tier_id = 'light'").all()).toEqual([]);
  });

  it('a big model narrowed under 32K by its num_ctx is refused too', async () => {
    expect((await put('standard', ['narrowed'])).status).toBe(400);
  });

  it('a small model already on a tier is kept when the tier is saved again (re-saving is never refused)', async () => {
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('light', 'small', 0)").run();
    expect((await put('light', ['small', 'big'])).status).toBe(200);
  });

  it('CONTROL: a model at or over 32K is accepted', async () => {
    expect((await put('heavy', ['big'])).status).toBe(200);
  });
});
