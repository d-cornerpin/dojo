// v3.5 A6 — OWNER RULING 2026-10-19: "if a user tries to select a local model for an agent or anything
// else that will not fit on the system's ram, don't let them select it. Pop up an error letting them
// know why. We already detect the system ram so let's use that info. If the user has enough ram open
// to fit the local model they are selecting then they can."
//
// FIX ROUND 1 (orchestrator rulings): the need is sized at the context the model will ACTUALLY run — an
// agent at its window, never under the 32K floor — and the room the Dojo's writer keeps for its largest
// summary job is never handed to an agent model. Sizes are decimal GB, as Ollama lists them. A model Ollama
// cannot size now is ALLOWED, the owner is told why, and it is judged when it first loads. The Dojo's
// decision model is never a choice. Ollama is a scripted fetch; nothing real is asked.
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
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { localModelFit, refuseUnfitLocalModel, refuseUncheckedAtFirstLoad } from '../local-model-fit.js';
import { Hono } from 'hono';
import { routerRouter } from '../../gateway/routes/router.js';
import { configRouter } from '../../gateway/routes/config.js';
import { pickDesktopReserve, ENGINE_RESERVE_BYTES, writerJobWindowTokens } from '../../services/num-ctx-calculator.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const GIB = 1024 ** 3;
const EMBEDDER = 274_302_471;
/** A Qwen-shaped architecture: 128-wide heads, 8 KV heads → 4,096 × blocks bytes of KV per token. */
const arch = (blocks: number): Record<string, unknown> => ({
  'general.architecture': 'qwen3', 'qwen3.block_count': blocks, 'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144,
});
const kvPerToken = (blocks: number): number => 2 * blocks * 8 * 128 * 2;
const ollama = {
  up: true,
  tags: [
    { name: 'nomic-embed-text:latest', size: EMBEDDER },
    { name: STANDARD_DECISION_MODEL.tag, size: STANDARD_DECISION_MODEL.bytes },
    { name: STANDARD_WRITER_MODEL.tag, size: STANDARD_WRITER_MODEL.bytes },
    { name: 'qwen3.5:9b', size: 6_600_000_000 },
    { name: 'qwen3.5:2b', size: 2_700_000_000 },
    { name: 'tiny:1b', size: 800_000_000 },
  ],
  show: { 'qwen3.5:9b': arch(36), 'qwen3.5:2b': arch(28), 'tiny:1b': arch(16), [STANDARD_WRITER_MODEL.tag]: arch(36) } as Record<string, Record<string, unknown>>,
};
const db = (): Database.Database => mockDb.current!;
const model = (id: string, provider: string, api: string, caps = '["chat"]'): void => {
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES (?, ?, ?, ?, ?, 262144, 1)`).run(id, provider, api, api, caps);
};
let totalRam = 16 * GIB;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  frames.list.length = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('cloud', 'Cloud', 'anthropic', NULL, 'api_key', 1)").run();
  model('m-9b', 'ollama-local', 'qwen3.5:9b');
  model('m-2b', 'ollama-local', 'qwen3.5:2b');
  model('m-1b', 'ollama-local', 'tiny:1b');
  model('m-unlisted', 'ollama-local', 'not-pulled:3b');
  model('m-cloud', 'cloud', 'big-cloud');
  model('m-writer', 'ollama-local', STANDARD_WRITER_MODEL.tag);
  model('m-decision', 'ollama-local', STANDARD_DECISION_MODEL.tag, '["decision"]');
  ollama.up = true;
  totalRam = 16 * GIB;
  vi.spyOn(os, 'totalmem').mockImplementation(() => totalRam);
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

/** Open memory on the Dojo's own box, by the calculator's reserves, the pair and the writer's job window. */
async function openOn(total: number): Promise<number> {
  const writerWorking = kvPerToken(36) * await writerJobWindowTokens(null);
  return total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - EMBEDDER
    - STANDARD_DECISION_MODEL.bytes - STANDARD_WRITER_MODEL.bytes - writerWorking;
}
const AT_32K = 32_000;

describe('the arithmetic (figures for the owner)', () => {
  it('16 GB: the pair and the writer\'s working memory leave no room for a local agent model', async () => {
    const open = await openOn(16 * GIB);
    expect(open).toBeLessThan(0);
    for (const id of ['m-9b', 'm-2b', 'm-1b']) expect((await localModelFit(id))!.fits).toBe(false);
    const v = await localModelFit('m-9b');
    expect(v!.contextTokens).toBe(AT_32K);
    expect(v!.needBytes).toBe(6_600_000_000 + kvPerToken(36) * AT_32K);
    expect(v!.message).toBe(
      'qwen3.5:9b needs about 11.3 GB of memory to run with its 32K-token window (6.6 GB of weights and 4.7 GB of working memory). '
      + "This box has 16 GB; after the desktop, the engine, the embedder, the Dojo's own two models and the working memory its writer "
      + 'keeps for summaries, about 0.0 GB is open. Choose a smaller local model or a cloud model.',
    );
    expect(await refuseUnfitLocalModel('m-9b')).toBe(v!.message);
  });

  it('32 GB: a 2B model fits at 32K; the 9B does not', async () => {
    totalRam = 32 * GIB;
    const open = await openOn(32 * GIB);
    const v9 = await localModelFit('m-9b');
    const v2 = await localModelFit('m-2b');
    expect(v9!.openBytes).toBe(open);
    expect(v9!.fits).toBe(false);
    expect(v2!.fits).toBe(true);
    expect(v2!.needBytes).toBe(2_700_000_000 + kvPerToken(28) * AT_32K);
  });

  it('an agent is sized at the window the engine actually sends (its recommendation), not under 32K', async () => {
    totalRam = 32 * GIB;
    db().prepare("UPDATE models SET num_ctx_recommended = 65536 WHERE id = 'm-2b'").run();
    expect((await localModelFit('m-2b'))!.contextTokens).toBe(65536);
  });

  it('a remote Ollama is judged by the RAM the owner entered for it, with nothing of the Dojo\'s charged to it', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, host_ram_gb) VALUES ('ollama-lan', 'LAN', 'ollama', 'http://10.0.0.5:11434', 'none', 1, 64)").run();
    model('m-9b-lan', 'ollama-lan', 'qwen3.5:9b');
    const v = await localModelFit('m-9b-lan');
    expect(v!.fits).toBe(true);
    expect(v!.openBytes).toBe(64 * GIB - pickDesktopReserve(64 * GIB) - ENGINE_RESERVE_BYTES);
  });
});

describe('the decision model is never a choice', () => {
  it('refused for an agent and for a job, in plain words', async () => {
    const words = "tev1:4b-q4_K_M is the Dojo's decision model: it answers the Dojo's own yes/no questions and cannot run an agent or write. Choose another model.";
    expect(await refuseUnfitLocalModel('m-decision')).toBe(words);
    expect(await refuseUnfitLocalModel('m-decision', null, 'job')).toBe(words);
  });
});

describe('what is never refused', () => {
  it('a cloud model', async () => { expect(await localModelFit('m-cloud')).toBeNull(); });
  it('auto', async () => { expect(await localModelFit('auto')).toBeNull(); });
  it('re-saving the model the agent already has', async () => { expect(await refuseUnfitLocalModel('m-9b', 'm-9b')).toBeNull(); });
});

describe('RULING: what Ollama cannot size now is allowed, told, and judged at its first load', () => {
  it('Ollama down: allowed, and the owner is told the fit will be checked when it first loads', async () => {
    ollama.up = false;
    expect(await refuseUnfitLocalModel('m-9b')).toBeNull();
    expect(frames.list.filter((f) => f.severity === 'warning').map((f) => f.error)).toEqual([
      'qwen3.5:9b was selected, but its memory fit could not be checked now (Ollama is not answering). It will be checked when the model first loads, and refused then if it does not fit this box\'s memory.',
    ]);
  });

  it('not downloaded yet: allowed with its own reason', async () => {
    expect(await refuseUnfitLocalModel('m-unlisted')).toBeNull();
    expect(frames.list.some((f) => f.error?.includes('(the model is not downloaded yet)'))).toBe(true);
  });

  it('the first load refuses it with the plain error when it does not fit — and keeps refusing', async () => {
    ollama.up = false;
    await refuseUnfitLocalModel('m-9b');
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-9b', 'agent')).rejects.toThrow(/^qwen3\.5:9b needs about 11\.3 GB of memory/);
    await expect(refuseUncheckedAtFirstLoad('m-9b', 'agent')).rejects.toThrow(/needs about/);
  });

  it('the first load lets it run when it fits, and the mark and its card go', async () => {
    totalRam = 32 * GIB;
    ollama.up = false;
    await refuseUnfitLocalModel('m-2b');
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-2b', 'agent')).resolves.toBeUndefined();
    expect(frames.list.some((f) => f.severity === 'info' && f.error?.startsWith('qwen3.5:2b was selected'))).toBe(true);
    ollama.up = false;   // no longer marked: nothing to ask
    await expect(refuseUncheckedAtFirstLoad('m-2b', 'agent')).resolves.toBeUndefined();
  });

  it('a model selected normally is not re-judged at load', async () => {
    await expect(refuseUncheckedAtFirstLoad('m-9b', 'agent')).resolves.toBeUndefined();
  });
});

describe('the doors answer with the sentence (no new UX: the 400 message is the form\'s error banner)', () => {
  const app = new Hono().route('/router', routerRouter).route('/config', configRouter);
  const put = (p: string, body: unknown): Promise<Response> => Promise.resolve(app.request(p, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));

  it('a router tier refuses an unfit local model and the decision model, and keeps one already in it', async () => {
    const res = await put('/router/tiers/light/models', { models: [{ modelId: 'm-9b', priority: 0 }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^qwen3\.5:9b needs about 11\.3 GB of memory/);
    expect((await put('/router/tiers/light/models', { models: [{ modelId: 'm-decision', priority: 0 }] })).status).toBe(400);
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('light', 'm-9b', 0)").run();
    expect((await put('/router/tiers/light/models', { models: [{ modelId: 'm-9b', priority: 0 }, { modelId: 'm-cloud', priority: 1 }] })).status).toBe(200);
  });

  it('service-agent, summary-writer, voice-opener and vision-fallback settings refuse it too', async () => {
    for (const key of ['healer_model_id', 'compaction_model_id', 'voice.opener_model', 'dojo_fallback_vision_model_id']) {
      expect((await put(`/config/settings/${key}`, { value: 'm-9b' })).status, key).toBe(400);
    }
    expect((await put('/config/settings/voice.opener_model', { value: 'off' })).status).toBe(200);
    expect((await put('/config/settings/compaction_model_id', { value: 'm-cloud' })).status).toBe(200);
  });

  it('the router\'s model list offers no decision model', async () => {
    const res = await app.request('/router/available-models');
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).not.toContain('m-decision');
    expect(ids).toContain('m-9b');
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
      .map((f) => ({ rel: f.rel, floor: calls(f.code, 'refuseSmallMainModel'), fit: calls(f.code, 'refuseUnfitLocalModel') + calls(f.code, 'localModelFit') }))
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

describe('the setup probe the role steps default from (no marks, no cards)', () => {
  it('answers the refusal for an unfit model and null for one the server accepts', async () => {
    const { setupDepsRouter } = await import('../../gateway/routes/setup-deps.js');
    const ask = async (id: string): Promise<string | null> =>
      ((await (await setupDepsRouter.request(`/model-fit/${id}`)).json()) as { data: { refused: string | null } }).data.refused;
    expect(await ask('m-9b')).toMatch(/needs about/);
    expect(await ask('m-decision')).toMatch(/decision model/);
    expect(await ask('m-cloud')).toBeNull();
    ollama.up = false;
    expect(await ask('m-9b')).toBeNull();
    expect(frames.list).toEqual([]);
  });
});
