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

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string; cardClass?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { localModelFit, refuseUnfitLocalModel, refuseUncheckedAtFirstLoad } from '../local-model-fit.js';
import { Hono } from 'hono';
import { routerRouter } from '../../gateway/routes/router.js';
import { configRouter } from '../../gateway/routes/config.js';
import { pickDesktopReserve, ENGINE_RESERVE_BYTES } from '../../services/num-ctx-calculator.js';
import { writerJobWindowTokens, writerReservedWindowTokens, decisionWindowTokens } from '../../services/dojo-working-memory.js';
import { MIN_UTILITY_NUM_CTX } from '../utility-dial.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';
import { setupDepsRouter } from '../../gateway/routes/setup-deps.js';

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
  // t268 fix round 1 (I-2): the writer's room is the jobs it really has on this box (edited: it was always the summary job).
  const writerWorking = kvPerToken(36) * await writerReservedWindowTokens(null);
  return total - pickDesktopReserve(total) - ENGINE_RESERVE_BYTES - EMBEDDER
    - STANDARD_DECISION_MODEL.bytes - STANDARD_WRITER_MODEL.bytes - writerWorking;
}
const AT_32K = 32_000;

describe('the arithmetic (figures for the owner)', () => {
  // t268 fix round 1 (I-2, edited): the writer reserves only its system jobs unless it is the Summarization pick, so
  // 16 GB now has ~2.4 GB open (it had none) — still too little for the smallest local agent model here (2.9 GB).
  it('16 GB: the pair and the writer\'s working memory leave no room for a local agent model', async () => {
    const open = await openOn(16 * GIB);
    expect(open).toBeLessThan(800_000_000 + kvPerToken(16) * AT_32K);
    for (const id of ['m-9b', 'm-2b', 'm-1b']) expect((await localModelFit(id))!.fits).toBe(false);
    const v = await localModelFit('m-9b');
    expect(v!.contextTokens).toBe(AT_32K);
    expect(v!.needBytes).toBe(6_600_000_000 + kvPerToken(36) * AT_32K);
    expect(v!.message).toBe(
      'qwen3.5:9b needs about 11.3 GB of memory to run with its 32K-token window (6.6 GB of weights and 4.7 GB of working memory). '
      + "This box has 16 GB; after the desktop, the engine, the embedder, the Dojo's own two models and the working memory they "
      + `keep for summaries, about ${(open / 1e9).toFixed(1)} GB is open. Choose a smaller local model or a cloud model.`,
    );
    expect(await refuseUnfitLocalModel('m-9b')).toBe(v!.message);
  });

  it('32 GB: each agent\'s own model writing summaries, the 9B fits at 32K; with an agent whose own model is the writer only the 2B does', async () => {
    totalRam = 32 * GIB;
    const open = await openOn(32 * GIB);
    const v9 = await localModelFit('m-9b');
    const v2 = await localModelFit('m-2b');
    expect(v9!.openBytes).toBe(open);
    expect(v9!.fits).toBe(true);   // t268 fix round 1 (I-2, edited: it was refused while the summary room was always reserved)
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('ag-writer', 'Writer', 'm-writer', 'idle', '{}')").run();   // v3.5 field fix 3: no Settings pick; an agent whose own model is the writer assigns its summaries to it
    expect((await localModelFit('m-9b'))!.fits).toBe(false);
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

describe('N1 (fix round 2): the Dojo\'s writer is never charged twice', () => {
  it('as a job (summary writer) its reserved room IS its fit, even on 16 GB', async () => {
    expect(await refuseUnfitLocalModel('m-writer', null, 'job')).toBeNull();
    expect((await localModelFit('m-writer', 'job'))!.needBytes).toBe(0);
  });

  it('as an agent it needs only the KV beyond the room already reserved for its jobs', async () => {
    totalRam = 32 * GIB;
    const room = await writerReservedWindowTokens(null);   // t268 (I-2, edited): the room its jobs reserve now
    expect((await localModelFit('m-writer'))!.needBytes).toBe(kvPerToken(36) * Math.max(0, AT_32K - room));
  });

  it('a pick of the writer made while Ollama was down never makes its summary calls fail', async () => {
    ollama.up = false;
    expect(await refuseUnfitLocalModel('m-writer', null, 'job')).toBeNull();
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-writer')).resolves.toBeUndefined();
  });
});

describe('fix round 2: the decision model\'s own working memory is reserved (it reads source + summary)', () => {
  it('when Ollama describes the decision model, its KV at the check\'s window comes out of what is open', async () => {
    totalRam = 32 * GIB;
    const before = (await localModelFit('m-2b'))!.openBytes;
    ollama.show[STANDARD_DECISION_MODEL.tag] = arch(36);
    const after = (await localModelFit('m-2b'))!.openBytes;
    // t268 ruling 2 (edited: it read the writer's job window, which the decision model never ran at — B5): the
    // reserve is the window the decision model REALLY runs at, the one number `decisionWindowTokens()` answers.
    expect(before - after).toBe(kvPerToken(36) * await decisionWindowTokens());
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_model_window', '27648')").run();   // the derived tag, made at install
    expect(before - (await localModelFit('m-2b'))!.openBytes).toBe(kvPerToken(36) * 27_648);
    delete ollama.show[STANDARD_DECISION_MODEL.tag];
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
  const WORDS = (name: string): string => `Dojo: ${name} was selected, but its memory fit could not be checked then (Ollama was not answering, or the model was not downloaded yet). `
    + "It will be checked when the model first loads, and refused then if it does not fit this box's memory.";
  const inUse = (modelId: string): void => { db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pm_agent_model', ?)").run(modelId); };

  // v3.5 field fix 3 (#9, OR-FIELD3 (c)): the fit is checked at the first load by itself, so the owner is told once on an
  // INFORMATIONAL card (a toast that leaves by itself, never red), and a reload does not re-derive it (it was N2's lasting card).
  it('Ollama down: allowed, and the owner is told once on an informational card', async () => {
    ollama.up = false;
    expect(await refuseUnfitLocalModel('m-9b')).toBeNull();
    expect(await refuseUnfitLocalModel('m-9b')).toBeNull();
    expect(frames.list.filter((f) => f.severity === 'warning').map((f) => f.error)).toEqual([WORDS('qwen3.5:9b')]);
    expect(frames.list.filter((f) => f.severity === 'warning').map((f) => f.cardClass)).toEqual(['informational']);
    inUse('m-9b');
    expect(standingOwnerNotices().map((c) => c.words)).not.toContain(WORDS('qwen3.5:9b'));
  });

  it('not downloaded yet: allowed the same way', async () => {
    expect(await refuseUnfitLocalModel('m-unlisted')).toBeNull();
    inUse('m-unlisted');
    expect(frames.list.filter((f) => f.severity === 'warning').map((f) => f.error)).toEqual([WORDS('not-pulled:3b')]);
    expect(standingOwnerNotices().map((c) => c.words)).not.toContain(WORDS('not-pulled:3b'));
  });

  it('N7: a pick the door then refuses (the 32K floor) is neither marked nor told', async () => {
    ollama.up = false;
    expect(await refuseUnfitLocalModel('m-9b', null, 'agent', () => 'too small')).toBe('too small');
    expect(frames.list).toEqual([]);
    await expect(refuseUncheckedAtFirstLoad('m-9b')).resolves.toBeUndefined();
  });

  it('the first load refuses it with the plain error when it does not fit — keeps refusing — and the card ends', async () => {
    ollama.up = false;
    await refuseUnfitLocalModel('m-9b');
    inUse('m-9b');
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-9b')).rejects.toThrow(/^qwen3\.5:9b needs about 11\.3 GB of memory/);
    await expect(refuseUncheckedAtFirstLoad('m-9b')).rejects.toThrow(/needs about/);
    expect(standingOwnerNotices().map((c) => c.words)).not.toContain(WORDS('qwen3.5:9b'));
  });

  it('the first load lets it run when it fits, and the mark and its card go', async () => {
    totalRam = 32 * GIB;
    ollama.up = false;
    await refuseUnfitLocalModel('m-2b');
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-2b')).resolves.toBeUndefined();
    expect(frames.list.some((f) => f.severity === 'info' && f.error === WORDS('qwen3.5:2b'))).toBe(true);
    ollama.up = false;   // no longer marked: nothing to ask
    await expect(refuseUncheckedAtFirstLoad('m-2b')).resolves.toBeUndefined();
  });

  it('N8: an AGENT pick is judged as an agent even when its first call is a utility job', async () => {
    totalRam = 32 * GIB;
    db().prepare("UPDATE models SET num_ctx_recommended = 262144 WHERE id = 'm-2b'").run();
    ollama.up = false;
    await refuseUnfitLocalModel('m-2b', null, 'agent');
    ollama.up = true;
    await expect(refuseUncheckedAtFirstLoad('m-2b')).rejects.toThrow(/262K-token window/);
  });

  it('a model selected normally is not re-judged at load', async () => {
    await expect(refuseUncheckedAtFirstLoad('m-9b')).resolves.toBeUndefined();
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

  // v3.5 field fix 3 (owner ruling): there is no summary-writer setting, so it is no longer one of these doors.
  it('service-agent and vision-fallback settings refuse it too', async () => {
    for (const key of ['healer_model_id', 'dojo_fallback_vision_model_id']) {
      expect((await put(`/config/settings/${key}`, { value: 'm-9b' })).status, key).toBe(400);
    }
  });

  it('the router\'s model list offers no decision model', async () => {
    const res = await app.request('/router/available-models');
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).not.toContain('m-decision');
    expect(ids).toContain('m-9b');
  });
});

describe('the setup probe the role steps default from (no marks, no cards)', () => {
  it('answers the refusal for an unfit model and null for one the server accepts', async () => {
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

// t268 fix round 1 (I-2) + ORCHESTRATOR RULING, after the owner's ruling of 2026-10-24 ("The agents model."): each
// agent's own model writes its summaries, so the Dojo's writer's reserved room follows the jobs it ACTUALLY has
// here — its summary job's window only when it is the explicit Summarization pick; otherwise its system jobs
// (titles, the fallback) at the sizes they really ran at (Ollama's own counts, the cost rows).
describe('I-2: the writer\'s reserved room is the jobs it really has', () => {
  const ran = (purpose: string, tokens: number): void => {
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, latency_ms, request_type, call_purpose, created_at)
      VALUES (?, 'a', 'm-writer', 'ollama-local', ?, 10, 0, 100, ?, ?, datetime('now'))`).run(`c-${purpose}-${tokens}`, tokens, purpose, purpose);
  };

  it('not the Summarization pick, no job run yet: the smallest window any job asks for', async () => {
    expect(await writerReservedWindowTokens(null)).toBe(MIN_UTILITY_NUM_CTX);
  });

  // Fix round 2 (ruling): the ASSIGNED jobs on this box's configuration, deterministic — never the largest job of
  // the last 30 days (edited: that clause pinned the round-1 rule).
  it('not the pick: its assigned system jobs only (a title\'s bounded window), however large a job it ran', async () => {
    ran('ask_title', 1_500);
    ran('memory_summarize', 40_000);   // a fallback summary: sized to the free memory when it runs, never reserved
    expect(await writerReservedWindowTokens(null)).toBe(MIN_UTILITY_NUM_CTX);
  });

  // Fix round 3 (owner ruling; edited): an auto-routed agent writes with its router's pick, so it reserves nothing.
  it('an agent whose summaries are assigned to the writer reserves its summary job: only when the writer is its fixed model', async () => {
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('ag-auto', 'Auto', 'auto', 'idle', '{}')").run();
    expect(await writerReservedWindowTokens(null)).toBe(MIN_UTILITY_NUM_CTX);
    db().prepare("UPDATE agents SET model_id = NULL WHERE id = 'ag-auto'").run();
    expect(await writerReservedWindowTokens(null)).toBe(MIN_UTILITY_NUM_CTX);
    db().prepare("UPDATE agents SET model_id = 'm-writer' WHERE id = 'ag-auto'").run();
    expect(await writerReservedWindowTokens(null)).toBe(await writerJobWindowTokens(null));
    // v3.5 field fix 3: an old Summarization pick row is read by nothing; the agent on the writer still assigns it.
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'm-cloud')").run();
    expect(await writerReservedWindowTokens(null)).toBe(await writerJobWindowTokens(null));
  });

  // Fix round 4 (N-E): an auto-routed agent's summaries walk its router's standard-tier chain, so the writer placed in
  // a tier of that chain has them assigned exactly as a fixed-model writer does.
  it('the writer placed in a router tier an auto-routed agent walks is reserved like a fixed-model writer', async () => {
    db().prepare("DELETE FROM router_tier_models WHERE model_id = 'm-writer'").run();
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('heavy', 'm-writer', 5)").run();
    expect(await writerReservedWindowTokens(null), 'no auto-routed agent: nobody walks that tier for summaries').toBe(MIN_UTILITY_NUM_CTX);
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('ag-auto', 'Auto', 'auto', 'idle', '{}')").run();
    expect(await writerReservedWindowTokens(null)).toBe(await writerJobWindowTokens(null));
    db().prepare("DELETE FROM router_tier_models WHERE model_id = 'm-writer'").run();
    db().prepare("INSERT INTO router_tier_models (tier_id, model_id, priority) VALUES ('system', 'm-writer', 0)").run();
    expect(await writerReservedWindowTokens(null), 'the system tier (titles) is not a tier a summary walks').toBe(MIN_UTILITY_NUM_CTX);
  });

  it('an agent whose own model is the writer: its summary job\'s window', async () => {
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('ag-writer', 'Writer', 'm-writer', 'idle', '{}')").run();   // v3.5 field fix 3: no Settings pick; an agent whose own model is the writer assigns its summaries to it
    expect(await writerReservedWindowTokens(null)).toBe(await writerJobWindowTokens(null));
  });

  it('the fit charges exactly that room', async () => {
    totalRam = 32 * GIB;
    const open = await openOn(32 * GIB);
    expect((await localModelFit('m-2b'))!.openBytes).toBe(open);
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('ag-writer', 'Writer', 'm-writer', 'idle', '{}')").run();   // v3.5 field fix 3: no Settings pick; an agent whose own model is the writer assigns its summaries to it
    expect(open - (await localModelFit('m-2b'))!.openBytes).toBe(kvPerToken(36) * (await writerJobWindowTokens(null) - MIN_UTILITY_NUM_CTX));
  });
});
