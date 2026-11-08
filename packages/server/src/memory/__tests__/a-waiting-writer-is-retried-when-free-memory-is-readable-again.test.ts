// A waiting writer is asked again when the free memory can be read again: free memory that cannot be read is
// unknown, and the small writer is not admitted on an unknown (the span waits, rows whole, nothing dialled). Ollama
// answering its health check is the signal. Driven through `checkAndCompact` and the real `checkOllamaHealth`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';

vi.mock('../../db/connection.js', async () => (await import('./helpers/one-writer-box.js')).connectionMock());
vi.mock('../../agent/model.js', async () => (await import('./helpers/one-writer-box.js')).modelMock());
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e, getWSStatus: () => ({}) }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: () => 'archive-1', isDreamerIgnored: () => false, getArchiveHighWaterMark: () => null }));

import { box, seedBox, AGENT, OWN, WRITER } from './helpers/one-writer-box.js';
import { checkAndCompact } from '../compaction.js';
import { markWaiting, waiting, EVERY_AGENT, __resetSummaryWriterHealthForTests } from '../writer.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { checkOllamaHealth } from '../../services/ollama.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const arch = { 'general.architecture': 'qwen3', 'qwen3.block_count': 36, 'qwen3.attention.head_count': 32, 'qwen3.attention.head_count_kv': 8, 'qwen3.embedding_length': 4096, 'qwen3.context_length': 262144 };
const ollama = { psOk: false };

beforeEach(async () => {
  ollama.psOk = false;
  __resetBrakesForTests(); __resetSummaryWriterHealthForTests();
  await seedBox();
  vi.spyOn(os, 'totalmem').mockImplementation(() => 32 * 1024 ** 3);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') return Response.json({ models: [{ name: STANDARD_WRITER_MODEL.tag, size: 3_400_000_000 }] });
    if (p === '/api/ps') return ollama.psOk ? Response.json({ models: [] }) : new Response('busy', { status: 500 });
    if (p === '/api/show') return Response.json({ model_info: arch });
    return new Response('no route', { status: 404 });
  }));
  markWaiting(EVERY_AGENT, OWN, '', 'not-answering');   // the own model is down: the small writer is the fallback
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); box.db?.close(); box.db = null; });

describe('a waiting writer is retried when free memory is readable again', () => {
  it('unreadable memory: the small writer waits, nothing is dialled; Ollama answering lets it write', async () => {
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls, 'never read as "all free"').toEqual([]);
    expect(waiting(AGENT, WRITER)).toBe('memory-unreadable');

    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls, 'no re-read while it waits').toEqual([]);

    ollama.psOk = true;
    await checkOllamaHealth('http://localhost:11434');
    expect(waiting(AGENT, WRITER)).toBeNull();
    await checkAndCompact(AGENT, OWN, 8_000, { force: true });
    expect(box.calls.length).toBeGreaterThan(0);
    expect(box.calls.every((m) => m === WRITER), 'only the small writer, never another model').toBe(true);
  });
});
