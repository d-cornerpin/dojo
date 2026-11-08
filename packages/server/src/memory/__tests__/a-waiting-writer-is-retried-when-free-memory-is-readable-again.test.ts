// A waiting writer is asked again when the free memory can be read again: free memory that cannot be read is
// unknown, and the small writer is not admitted on an unknown (the span waits, rows whole, nothing dialled). Ollama
// answering its health check is the signal. Driven through `checkAndCompact` and the real `checkOllamaHealth`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => {},
}));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e, getWSStatus: () => ({}) }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: () => 'archive-1', isDreamerIgnored: () => false, getArchiveHighWaterMark: () => null }));
const calls = vi.hoisted(() => [] as string[]);
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => { calls.push(p.modelId); return { content: 'Summary: the crew counted the depot and filed the manifests.', toolCalls: [], usage: {} }; },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { checkAndCompact } from '../compaction.js';
import { insertMessage } from '../message-store.js';
import { markWaiting, waiting, __resetSummaryWriterHealthForTests } from '../writer.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { checkOllamaHealth } from '../../services/ollama.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-memory-read';
const OWN = 'model-own';
const WRITER = 'm-writer';
const arch = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144 };
const ollama = { psOk: false };

beforeEach(() => {
  calls.length = 0; ollama.psOk = false;
  __resetBrakesForTests(); __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  vi.spyOn(os, 'totalmem').mockImplementation(() => 32 * 1024 ** 3);
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'none', 'http://localhost:11434', 1), ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://localhost:11441/v1', 1)").run();
  const model = db.prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, is_enabled) VALUES (?, ?, ?, ?, ?, ?, 4096, 0, 1)");
  model.run(OWN, 'p-own', 'Own', 'own', '["text","tools"]', 32_000);
  model.run(WRITER, 'ollama-local', STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag, '["chat"]', 262_144);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'A worker agent', 'idle', ?, '{}')").run(AGENT, OWN);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: [{ name: STANDARD_WRITER_MODEL.tag, size: 3_400_000_000 }] });
    if (p === '/api/ps') return ollama.psOk ? Response.json({ models: [] }) : new Response('busy', { status: 500 });
    if (p === '/api/show') return Response.json({ model_info: arch });
    return new Response('no route', { status: 404 });
  }));
  for (let t = 1; t <= 24; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] ${'Manifest line: crate, bay, weight, seal. '.repeat(40)}` });
  }
  markWaiting(AGENT, OWN, '', 'not-answering');   // the own model is down: the small writer is the fallback
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a waiting writer is retried when free memory is readable again', () => {
  it('unreadable memory: the small writer waits, nothing is dialled; Ollama answering lets it write', async () => {
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(calls, 'never read as "all free"').toEqual([]);
    expect(waiting(AGENT, WRITER)).toBe('memory-unreadable');

    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(calls, 'no re-read while it waits').toEqual([]);

    ollama.psOk = true;
    await checkOllamaHealth('http://localhost:11434');
    expect(waiting(AGENT, WRITER)).toBeNull();
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((m) => m === WRITER), 'only the small writer, never another model').toBe(true);
  });
});
