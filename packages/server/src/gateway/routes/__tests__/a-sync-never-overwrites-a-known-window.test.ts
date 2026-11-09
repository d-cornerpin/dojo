// ════════════════════════════════════════════════════════════════════════════════════
// M41 — A PROVIDER SYNC NEVER WRITES A GUESSED MODEL WINDOW AND NEVER OVERWRITES A KNOWN ONE.
//
// The incident (the owner's DeepSeek rows): the DeepSeek preset seeds its two models at a
// 1,000,000-token window and a 384,000 output cap. The SAME validate then asked the provider's
// /models list, which reports no window, and for every existing row wrote
// `context_length ?? 128000` plus a cap derived from that guess. Both rows ended at
// 128,000 / 16,384, and the figure the owner typed into the Model Limits editor was overwritten
// on the next validate in exactly the same way.
//
// A typical owner's expectation: a sync records what the provider SAYS. When the provider says
// nothing about a model's window, the figure already on the row (seeded, or typed by him) stays;
// a model the provider says nothing about is stored as "not set" (NULL), never as a made-up number.
// Driven through the real routes against real HTTP stubs for both sync blocks.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-m41-sync-window');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-m41-sync-window', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { clearSecretsCache } from '../../../config/loader.js';
import { configRouter } from '../config.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-m41-sync-window', '.dojo');

// One stub plays both providers: an OpenAI-compatible /v1/models list and Ollama's /api/tags + /api/show.
let server: http.Server;
let stubUrl = '';
/** What the provider's model list says about each model (set per case). */
let listed: Array<Record<string, unknown>> = [];
/** What Ollama's /api/show says per model (set per case); `null` = the call fails. */
let shown: Record<string, Record<string, unknown> | null> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.startsWith('/v1/models')) {
        reply(200, { object: 'list', data: listed });
      } else if (req.url === '/api/tags') {
        reply(200, { models: Object.keys(shown).map((name) => ({ name, size: 1 })) });
      } else if (req.url === '/api/show') {
        const name = (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { name?: string }).name ?? '';
        const body = shown[name];
        if (body === null || body === undefined) reply(500, {});
        else reply(200, body);
      } else {
        reply(404, {});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  fs.mkdirSync(path.join(FAKE_DOJO, 'logs'), { recursive: true });
  clearSecretsCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  listed = [];
  shown = {};
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const post = (p: string, body?: unknown): Promise<Response> =>
  configRouter.request(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const row = (providerId: string, apiModelId: string) => mockDb.current!.prepare(
  'SELECT context_window AS cw, max_output_tokens AS mo, input_cost_per_m AS ci FROM models WHERE provider_id = ? AND api_model_id = ?',
).get(providerId, apiModelId) as { cw: number | null; mo: number | null; ci: number | null };

function seedCompat(): void {
  mockDb.current!.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('compat', 'Compat', 'openai-compatible', ?, 'none')`).run(`${stubUrl}/v1`);
}
function seedModel(apiModelId: string, cw: number | null, mo: number | null): void {
  mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled)
    VALUES (?, 'compat', ?, ?, '["chat"]', ?, ?, 0.14, 0.28, 0)`).run(`m-${apiModelId}`, apiModelId, apiModelId, cw, mo);
}

describe('M41 — the openai-compatible sync', () => {
  it('a seeded 1,000,000 / 384,000 survives a validate whose model list reports no window', async () => {
    seedCompat();
    seedModel('deepseek-v4-flash', 1_000_000, 384_000);
    listed = [{ id: 'deepseek-v4-flash', object: 'model' }];
    expect((await post('/providers/compat/validate')).status).toBe(200);
    expect(row('compat', 'deepseek-v4-flash')).toMatchObject({ cw: 1_000_000, mo: 384_000 });
  });

  it('a window the owner typed (262,144) survives the next validate', async () => {
    seedCompat();
    seedModel('deepseek-v4-pro', 262_144, 65_536);
    listed = [{ id: 'deepseek-v4-pro', object: 'model' }];
    await post('/providers/compat/validate');
    expect(row('compat', 'deepseek-v4-pro')).toMatchObject({ cw: 262_144, mo: 65_536 });
  });

  it('a window the provider DOES report is taken, with the cap the provider reports', async () => {
    seedCompat();
    seedModel('local-m', 1_000_000, 384_000);
    listed = [{ id: 'local-m', context_length: 65_536, top_provider: { max_completion_tokens: 8_000 } }];
    await post('/providers/compat/validate');
    expect(row('compat', 'local-m')).toMatchObject({ cw: 65_536, mo: 8_000 });
  });

  it('a reported window with no reported cap never replaces a cap that is already known', async () => {
    seedCompat();
    seedModel('local-m', 1_000_000, 384_000);
    listed = [{ id: 'local-m', context_length: 65_536 }];
    await post('/providers/compat/validate');
    expect(row('compat', 'local-m')).toMatchObject({ cw: 65_536, mo: 384_000 });
  });

  it('a reported window fills a BLANK cap (derived from the reported window only)', async () => {
    seedCompat();
    seedModel('local-m', null, null);
    listed = [{ id: 'local-m', context_length: 65_536 }];
    await post('/providers/compat/validate');
    const r = row('compat', 'local-m');
    expect(r.cw).toBe(65_536);
    expect(r.mo).toBe(16_384);
  });

  it('a model added by browsing, which the provider says nothing about, stays NULL (not a made-up 128,000)', async () => {
    seedCompat();
    listed = [{ id: 'browse-me', object: 'model' }];
    const add = await post('/providers/compat/add-model', { apiModelId: 'browse-me' });
    expect(add.status).toBeLessThan(300);
    expect(row('compat', 'browse-me')).toMatchObject({ cw: null, mo: null });
    await post('/providers/compat/validate');
    expect(row('compat', 'browse-me')).toMatchObject({ cw: null, mo: null });
  });

  it('prices still follow the provider: a reported price is taken, a missing one keeps the old value', async () => {
    seedCompat();
    seedModel('priced', null, null);
    listed = [{ id: 'priced', pricing: { prompt: '0.000001', completion: '0.000002' } }];
    await post('/providers/compat/validate');
    expect(row('compat', 'priced').ci).toBeCloseTo(1, 5);
    listed = [{ id: 'priced' }];
    await post('/providers/compat/validate');
    expect(row('compat', 'priced').ci).toBeCloseTo(1, 5);
  });
});

describe('M41 — the models list says which figure is in use while a window is not set', () => {
  it('a NULL window carries the window the engine budgets with; a stored one carries nothing assumed', async () => {
    seedCompat();
    seedModel('unset-one', null, null);
    seedModel('set-one', 262_144, 65_536);
    const res = await configRouter.request('/models');
    const list = (await res.json() as { data: Array<{ apiModelId: string; contextWindow: number | null; assumedContextWindow: number | null }> }).data;
    const by = (id: string) => list.find((m) => m.apiModelId === id)!;
    expect(by('unset-one').contextWindow).toBeNull();
    expect(by('unset-one').assumedContextWindow).toBe(200_000);
    expect(by('set-one').contextWindow).toBe(262_144);
    expect(by('set-one').assumedContextWindow).toBeNull();
  });
});

describe('M41 — the Ollama sync', () => {
  beforeEach(() => {
    mockDb.current!.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type) VALUES ('oll', 'Local', 'ollama', ?, 'none')`).run(stubUrl);
  });

  it('a model whose /api/show reports a window and cap is stored as reported', async () => {
    shown = { 'big:1b': { model_info: { 'llama.context_length': 40_960 }, parameters: 'num_predict 4096' } };
    await post('/providers/oll/validate');
    expect(row('oll', 'big:1b')).toMatchObject({ cw: 40_960, mo: 4_096 });
  });

  it('a model whose /api/show fails is inserted NULL, not 128,000 / 8,192', async () => {
    shown = { 'quiet:1b': null };
    await post('/providers/oll/validate');
    expect(row('oll', 'quiet:1b')).toMatchObject({ cw: null, mo: null });
  });

  it('a model whose /api/show says nothing about a window is inserted NULL', async () => {
    shown = { 'mute:1b': { model_info: {}, parameters: '' } };
    await post('/providers/oll/validate');
    expect(row('oll', 'mute:1b')).toMatchObject({ cw: null, mo: null });
  });

  it('a known figure survives a validate that learns nothing about it', async () => {
    mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
      VALUES ('m-known', 'oll', 'known:1b', 'known:1b', '["chat"]', 262144, 32768, 0)`).run();
    shown = { 'known:1b': null };
    await post('/providers/oll/validate');
    expect(row('oll', 'known:1b')).toMatchObject({ cw: 262_144, mo: 32_768 });
    shown = { 'known:1b': { model_info: {}, parameters: '' } };
    await post('/providers/oll/validate');
    expect(row('oll', 'known:1b')).toMatchObject({ cw: 262_144, mo: 32_768 });
  });

  it('a reported figure still updates a stored one', async () => {
    mockDb.current!.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
      VALUES ('m-k2', 'oll', 'k2:1b', 'k2:1b', '["chat"]', 4096, 1024, 0)`).run();
    shown = { 'k2:1b': { model_info: { 'x.context_length': 131_072 }, parameters: 'num_predict 16384' } };
    await post('/providers/oll/validate');
    expect(row('oll', 'k2:1b')).toMatchObject({ cw: 131_072, mo: 16_384 });
  });
});
