// t268 fix round 2 (5, ORCHESTRATOR RULING) — A FALLBACK SUMMARY ON THE DOJO'S WRITER IS SIZED TO THE MEMORY FREE
// WHEN IT RUNS, NEVER PERMANENTLY RESERVED. With each agent's own model writing its summaries (owner 2026-10-24),
// the small writer writes one only when that model cannot be reached; no room is set aside for it, so a span larger
// than what is free now is refused as too big (`tooBig`, never dialled) and the caller halves it — the existing
// path for a writer that cannot hold a span. When summaries ARE assigned to the writer, its room is reserved and
// nothing here refuses. The writer and Ollama are scripted; os.totalmem is the test's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const writer = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async () => { writer.calls++; return { content: 'The owner asked for the budget.', toolCalls: [], usage: {} }; },
  getContextWindow: () => 262_144, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { getOllamaLock } from '../../services/ollama-lock.js';
import { freeWriterWindowTokens } from '../../agent/local-model-fit.js';

const GIB = 1024 ** 3;
const AGENT_MODEL = 'agent-local:14b';
const arch = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144 };
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  writer.calls = 0;
  vi.spyOn(os, 'totalmem').mockImplementation(() => 32 * GIB);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('m-writer', 'ollama-local', ?, ?, '["chat"]', 262144, 1)`).run(STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.summary_check.invented', 'rule'), ('decision_mode.summary_check.dropped', 'rule'), ('decision_mode.summary_check.stated_current', 'rule')").run();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: [
      { name: STANDARD_WRITER_MODEL.tag, size: 3_400_000_000 }, { name: STANDARD_DECISION_MODEL.tag, size: 2_800_000_000 },
      { name: 'nomic-embed-text:latest', size: 274_302_471 }, { name: AGENT_MODEL, size: 13_000_000_000 },
    ] });
    if (p === '/api/show') {
      const name = (JSON.parse(init?.body ?? '{}') as { name?: string; model?: string });
      return (name.name ?? name.model) === STANDARD_WRITER_MODEL.tag ? Response.json({ model_info: arch }) : new Response('nf', { status: 404 });
    }
    return new Response('no route', { status: 404 });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const summarize = (chars: number) => generateSummary({ content: 'r'.repeat(chars), depth: 0, targetTokens: 5_000, agentId: 'agent-x', modelId: 'm-writer' });

describe('a fallback summary on the Dojo\'s writer fits the memory free now', () => {
  // First: the lock is the process's own, and a model it loaded stays loaded (idle) after its turn, as in Ollama.
  it('nothing else loaded: a whole leaf chunk fits the free memory and is written', async () => {
    expect(await summarize(120_000)).toMatchObject({ ok: true });
  });

  it('an agent\'s 13 GB model loaded beside the pair: a whole leaf chunk does not fit what is free, and is refused as too big', async () => {
    const lock = getOllamaLock();
    await lock.acquire('ollama-local', AGENT_MODEL);
    try {
      const free = await freeWriterWindowTokens();
      expect(free).not.toBeNull();
      const r = await summarize(120_000);   // ~48K tokens at the writer's density: more than is free
      expect(r).toMatchObject({ ok: false, tooBig: true });
      expect(writer.calls).toBe(0);
      expect(await summarize(12_000)).toMatchObject({ ok: true });   // a halved span that fits is written
      expect(writer.calls).toBe(1);
    } finally { lock.release('ollama-local', AGENT_MODEL); }
  });

  it('summaries assigned to the writer (the explicit pick): its room is reserved, so nothing here refuses', async () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'm-writer')").run();
    const lock = getOllamaLock();
    await lock.acquire('ollama-local', AGENT_MODEL);
    try { expect(await summarize(120_000)).toMatchObject({ ok: true }); } finally { lock.release('ollama-local', AGENT_MODEL); }
  });
});
