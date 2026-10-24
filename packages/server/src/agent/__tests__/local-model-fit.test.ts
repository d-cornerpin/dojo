// v3.5 A6 — OWNER RULING 2026-10-19: "if a user tries to select a local model for an agent or anything
// else that will not fit on the system's ram, don't let them select it. Pop up an error letting them
// know why. We already detect the system ram so let's use that info. If the user has enough ram open
// to fit the local model they are selecting then they can."
//
// Open memory = total − the desktop reserve − the engine − the embedder − the Dojo's two models (the
// calculator's own reserves). A model fits when its weights plus the KV cache of the calculator's
// smallest usable window fit in that. Ollama is a scripted fetch; nothing real is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { localModelFit, refuseUnfitLocalModel } from '../local-model-fit.js';
import { Hono } from 'hono';
import { routerRouter } from '../../gateway/routes/router.js';
import { configRouter } from '../../gateway/routes/config.js';
import { pickDesktopReserve, ENGINE_RESERVE_BYTES } from '../../services/num-ctx-calculator.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const GIB = 1024 ** 3;
const EMBEDDER = 274_302_471;
/** A Qwen-shaped architecture: 128-wide heads, 8 KV heads. */
const arch = (blocks: number): Record<string, unknown> => ({
  'general.architecture': 'qwen3', 'qwen3.block_count': blocks, 'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144,
});
const ollama = {
  up: true,
  tags: [
    { name: 'nomic-embed-text:latest', size: EMBEDDER },
    { name: 'qwen3.5:9b', size: 6_600_000_000 },
    { name: 'qwen3.5:2b', size: 2_700_000_000 },
    { name: 'tiny:1b', size: 800_000_000 },
  ],
  show: { 'qwen3.5:9b': arch(36), 'qwen3.5:2b': arch(28), 'tiny:1b': arch(16) } as Record<string, Record<string, unknown>>,
};
const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, api: string): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES (?, ?, ?, ?, '["chat"]', 262144, 1)`).run(id, provider, api, api);
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
  model('m-9b', 'ollama-local', 'qwen3.5:9b');
  model('m-2b', 'ollama-local', 'qwen3.5:2b');
  model('m-1b', 'ollama-local', 'tiny:1b');
  model('m-unlisted', 'ollama-local', 'not-pulled:3b');
  model('m-cloud', 'cloud', 'big-cloud');
  ollama.up = true;
  vi.spyOn(os, 'totalmem').mockReturnValue(16 * GIB);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (!ollama.up) throw new Error('fetch failed: ECONNREFUSED');
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: ollama.tags });
    if (p === '/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name: string }).name;
      const mi = ollama.show[name];
      return mi ? Response.json({ model_info: mi }) : new Response('not found', { status: 404 });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockDb.current?.close();
  mockDb.current = null;
});

/** The open memory on a 16 GB box, by the calculator's own reserves. */
const OPEN_16 = 16 * GIB - pickDesktopReserve(16 * GIB) - ENGINE_RESERVE_BYTES - EMBEDDER
  - STANDARD_DECISION_MODEL.bytes - STANDARD_WRITER_MODEL.bytes;
const kv = (blocks: number): number => 2 * blocks * 8 * 128 * 2 * 2048;   // fp16 K+V at the 2,048 floor

describe('worked cases on a 16 GB box', () => {
  it('qwen3.5:9b (6.6 GB) is refused, and the sentence says how much is open and why', async () => {
    const v = await localModelFit('m-9b');
    expect(v).not.toBeNull();
    expect(v!.fits).toBe(false);
    expect(v!.openBytes).toBe(OPEN_16);
    expect(v!.needBytes).toBe(6_600_000_000 + kv(36));
    expect(v!.message).toBe(
      'qwen3.5:9b needs about 6.4 GB of memory. This box has 16 GB; after the desktop, the engine, the embedder '
      + "and the Dojo's own two models, about 2.5 GB is open. Choose a smaller local model or a cloud model.",
    );
    expect(await refuseUnfitLocalModel('m-9b')).toBe(v!.message);
  });

  it('qwen3.5:2b (2.7 GB) with its smallest usable window does not fit what is open either (pinned)', async () => {
    const v = await localModelFit('m-2b');
    expect(v!.needBytes).toBe(2_700_000_000 + kv(28));
    expect(v!.needBytes).toBeGreaterThan(OPEN_16);
    expect(v!.fits).toBe(false);
  });

  it('a model that fits is allowed', async () => {
    const v = await localModelFit('m-1b');
    expect(v!.fits).toBe(true);
    expect(v!.message).toBeNull();
    expect(await refuseUnfitLocalModel('m-1b')).toBeNull();
  });

  it('a remote Ollama is judged by the RAM the owner entered for it', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, host_ram_gb) VALUES ('ollama-lan', 'LAN', 'ollama', 'http://10.0.0.5:11434', 'none', 1, 64)").run();
    model('m-9b-lan', 'ollama-lan', 'qwen3.5:9b');
    expect((await localModelFit('m-9b-lan'))!.fits).toBe(true);
  });
});

describe('what is never refused', () => {
  it('a cloud model', async () => { expect(await localModelFit('m-cloud')).toBeNull(); });
  it('auto', async () => { expect(await localModelFit('auto')).toBeNull(); });
  it('re-saving the model the agent already has', async () => { expect(await refuseUnfitLocalModel('m-9b', 'm-9b')).toBeNull(); });
  it('a model with no size on record', async () => { expect(await localModelFit('m-unlisted')).toBeNull(); });
  it('any model while Ollama does not answer (unknown is not refused)', async () => {
    ollama.up = false;
    expect(await refuseUnfitLocalModel('m-9b')).toBeNull();
  });
});

describe('the doors answer with the sentence (no new UX: the 400 message is the form\'s error banner)', () => {
  const app = new Hono().route('/router', routerRouter).route('/config', configRouter);
  const put = (p: string, body: unknown): Promise<Response> => Promise.resolve(app.request(p, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));

  it('a router tier refuses an unfit local model, and keeps one already in it', async () => {
    const res = await put('/router/tiers/light/models', { models: [{ modelId: 'm-9b', priority: 0 }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^qwen3\.5:9b needs about 6\.4 GB of memory/);
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('light', 'm-9b', 0)").run();
    expect((await put('/router/tiers/light/models', { models: [{ modelId: 'm-9b', priority: 0 }, { modelId: 'm-1b', priority: 1 }] })).status).toBe(200);
  });

  it('a service agent\'s model setting and the summary writer setting refuse it too', async () => {
    expect((await put('/config/settings/healer_model_id', { value: 'm-9b' })).status).toBe(400);
    expect((await put('/config/settings/compaction_model_id', { value: 'm-9b' })).status).toBe(400);
    expect((await put('/config/settings/compaction_model_id', { value: 'm-1b' })).status).toBe(200);
  });
});

describe('the door census: every door the 32K floor guards also asks whether the model fits', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
  const calls = (code: string, fn: string): number => (code.match(new RegExp(`\\b${fn}\\(`, 'g')) ?? []).length;
  const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f), code: fs.readFileSync(f, 'utf-8') }))
    .filter((f) => !['agent/main-model-floor.ts', 'agent/local-model-fit.ts'].includes(f.rel));

  it('the same number of calls in every file', () => {
    const doors = files.filter((f) => calls(f.code, 'refuseSmallMainModel') > 0);
    expect(doors.length).toBeGreaterThanOrEqual(7);
    const short = doors
      .map((f) => ({ rel: f.rel, floor: calls(f.code, 'refuseSmallMainModel'), fit: calls(f.code, 'refuseUnfitLocalModel') }))
      .filter((d) => d.fit < d.floor);
    expect(short, 'a door refuses a small main model but never asks whether a local model fits').toEqual([]);
  });

  it('"anything else": a router tier assignment and the summary writer setting ask too', () => {
    const router = files.find((f) => f.rel === 'gateway/routes/router.ts')!;
    expect(calls(router.code, 'refuseUnfitLocalModel')).toBeGreaterThan(0);
    const config = files.find((f) => f.rel === 'gateway/routes/config.ts')!;
    expect(config.code).toMatch(/LOCAL_MODEL_SETTING_KEYS/);
  });
});
