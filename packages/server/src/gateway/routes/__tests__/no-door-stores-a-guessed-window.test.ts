// ════════════════════════════════════════════════════════════════════════════════════
// M41 fix round 1 — EVERY DOOR THAT STORES A MODEL'S WINDOW, CAP OR PRICE STORES WHAT IS KNOWN.
//
// The first M41 pass fixed the openai-compatible and Ollama syncs. The same defect sat in four more
// doors: the OpenAI create and validate paths inserted `128000 / 16384` and a price of `2.50 / 10.0`
// for any model they did not know; the DeepSeek live listing inserted `64k / 8192` and a price; the
// setup-time Ollama discovery inserted `32000`; and the Anthropic validate overwrote the window and
// the cap on every run, from a source whose own fallbacks were `200000 / 8192`.
//
// Rule for all of them: a model the catalog or the provider genuinely knows keeps that figure;
// anything not reported is stored NULL (window, cap AND prices; an unknown price is NULL, as the
// OpenRouter branch already did) and no sync overwrites a known figure with a guess.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-m41-doors');
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-m41-doors', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'sk-test-credential',
  setProviderCredential: () => undefined,
}));

// The Anthropic client: `models.list()` answers whatever the case sets; `messages.create` is the credential probe.
const { anthropicList } = vi.hoisted(() => ({ anthropicList: { data: [] as Array<Record<string, unknown>> } }));
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  class Anthropic {
    static APIError = APIError;
    messages = { create: async () => ({}) };
    models = { list: async () => ({ data: anthropicList.data }) };
  }
  return { default: Anthropic };
});

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import { setupDepsRouter } from '../setup-deps.js';

const FAKE_DOJO = path.join((process.env.DOJO_TEST_HOME_ROOT || realOs.tmpdir()), 'dojo-m41-doors', '.dojo');

/** What each outside server answers; set per case. */
const outside = {
  openaiIds: [] as string[],
  deepseekIds: [] as string[],
  ollama: {} as Record<string, Record<string, unknown> | null>,
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  fs.rmSync(path.join(FAKE_DOJO, 'secrets.yaml'), { force: true });
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  outside.openaiIds = []; outside.deepseekIds = []; outside.ollama = {}; anthropicList.data = [];
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith('https://api.openai.com/v1/models')) return json({ data: outside.openaiIds.map((id) => ({ id })) });
    if (url.startsWith('https://api.deepseek.com/models')) return json({ data: outside.deepseekIds.map((id) => ({ id })) });
    if (url === 'http://localhost:11434/api/tags') return json({ models: Object.keys(outside.ollama).map((name) => ({ name })) });
    if (url === 'http://localhost:11434/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name?: string }).name ?? '';
      const body = outside.ollama[name];
      return body ? json(body) : json({}, 500);
    }
    throw new Error(`unexpected outside call: ${url}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; mockDb.current?.close(); mockDb.current = null; });

const post = (p: string, body?: unknown): Promise<Response> =>
  configRouter.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Row = { cw: number | null; mo: number | null; ci: number | null; co: number | null };
const row = (providerId: string, apiModelId: string): Row => mockDb.current!.prepare(
  'SELECT context_window AS cw, max_output_tokens AS mo, input_cost_per_m AS ci, output_cost_per_m AS co FROM models WHERE provider_id = ? AND api_model_id = ?',
).get(providerId, apiModelId) as Row;
const NOTHING: Row = { cw: null, mo: null, ci: null, co: null };

describe('M41 — the OpenAI doors', () => {
  it('create: a model the catalog knows keeps its figures; one it does not know is stored NULL, prices too', async () => {
    outside.openaiIds = ['gpt-4o', 'gpt-future-9'];
    const res = await post('/providers', { id: 'oa', name: 'OpenAI', type: 'openai', authType: 'api_key', credential: 'sk-x' });
    expect(res.status).toBe(201);
    expect(row('oa', 'gpt-4o')).toEqual({ cw: 128000, mo: 16384, ci: 2.5, co: 10 });
    expect(row('oa', 'gpt-future-9')).toEqual(NOTHING);
  });

  it('validate: an unknown live model is inserted NULL (window, cap, both prices)', async () => {
    mockDb.current!.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('oa', 'OpenAI', 'openai', 'api_key')`).run();
    outside.openaiIds = ['gpt-future-9'];
    expect((await post('/providers/oa/validate')).status).toBe(200);
    expect(row('oa', 'gpt-future-9')).toEqual(NOTHING);
  });
});

describe('M41 — the DeepSeek doors', () => {
  it('create: the reference catalog keeps its documented figures; a live-listed unknown id is stored NULL', async () => {
    outside.deepseekIds = ['deepseek-v4-flash', 'deepseek-next-1'];
    const res = await post('/providers', { id: 'ds', name: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com', authType: 'api_key', credential: 'sk-x' });
    expect(res.status).toBe(201);
    expect(row('ds', 'deepseek-v4-flash')).toMatchObject({ cw: 1_000_000, mo: 32_000, ci: 0.14, co: 0.28 });
    expect(row('ds', 'deepseek-next-1')).toEqual(NOTHING);
  });
});

describe('M41 — the Anthropic validate', () => {
  beforeEach(() => {
    mockDb.current!.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('an', 'Anthropic', 'anthropic', 'api_key')`).run();
  });
  const seed = (apiModelId: string, cw: number | null, mo: number | null) => mockDb.current!.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled)
     VALUES (?, 'an', ?, ?, '["chat"]', ?, ?, 3, 15, 0)`).run(`m-${apiModelId}`, apiModelId, apiModelId, cw, mo);

  it('a figure the owner typed survives a validate whose model list reports none', async () => {
    seed('claude-sonnet-x', 262_144, 65_536);
    anthropicList.data = [{ id: 'claude-sonnet-x', display_name: 'Sonnet X', max_input_tokens: null, max_tokens: null }];
    expect((await post('/providers/an/validate')).status).toBe(200);
    expect(row('an', 'claude-sonnet-x')).toMatchObject({ cw: 262_144, mo: 65_536 });
  });

  it('figures the provider DOES report are taken (max_input_tokens, max_tokens)', async () => {
    seed('claude-sonnet-x', 200_000, 8_192);
    anthropicList.data = [{ id: 'claude-sonnet-x', display_name: 'Sonnet X', max_input_tokens: 1_000_000, max_tokens: 64_000 }];
    await post('/providers/an/validate');
    expect(row('an', 'claude-sonnet-x')).toMatchObject({ cw: 1_000_000, mo: 64_000 });
  });

  it('a new model the provider says nothing about is stored NULL; a known family keeps its catalog price, an unknown family has none', async () => {
    anthropicList.data = [
      { id: 'claude-haiku-new', display_name: 'Haiku New' },
      { id: 'claude-mystery-1', display_name: 'Mystery' },
    ];
    await post('/providers/an/validate');
    expect(row('an', 'claude-haiku-new')).toEqual({ cw: null, mo: null, ci: 0.8, co: 4 });
    expect(row('an', 'claude-mystery-1')).toEqual(NOTHING);
  });
});

describe('M41 — the setup-time Ollama discovery', () => {
  const discover = () => setupDepsRouter.request('/ollama/auto-configure', { method: 'POST' });

  it('a model Ollama describes is stored with the reported window; one it cannot describe is stored NULL, never 32000', async () => {
    outside.ollama = {
      'known:7b': { model_info: { 'llama.context_length': 40_960 }, parameters: 'num_predict 4096' },
      'silent:7b': null,
    };
    expect((await discover()).status).toBe(200);
    expect(row('ollama-local', 'known:7b')).toMatchObject({ cw: 40_960, mo: 4_096 });
    expect(row('ollama-local', 'silent:7b')).toMatchObject({ cw: null, mo: null });
  });
});
