// t268 fix round 2 (1) — OWNER RULING 2026-10-24 ("The agents model."): the nightly rebuild of contaminated
// summaries follows the same order as every summary path — the Settings pick, else EACH AGENT's own model, and
// the Dojo's small writer only when that agent's model cannot be reached. It used to resolve one writer for every
// agent with no agent model, which put the small local writer on every agent's summaries. The writer is scripted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {},
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'), isDreamerIgnored: vi.fn(() => false), getArchiveHighWaterMark: vi.fn(() => null),
}));
const writers = vi.hoisted(() => ({ calls: [] as Array<{ modelId: string; content: string }> }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string; messages: Array<{ content: string }> }) => {
    writers.calls.push({ modelId: p.modelId, content: String(p.messages[0]?.content ?? '') });
    return { content: 'The owner asked which bay; the agent answered bay three.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary } from '../dag.js';
import { runSummaryRebuildBatch } from '../summary-rebuild.js';
import { __resetSummaryWriterHealthForTests, noteDidNotAnswerInTurn } from '../summary-writer-health.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const AGENTS = [{ id: 'agent-one', model: 'own-one', provider: 'cloud-one' }, { id: 'agent-two', model: 'own-two', provider: 'cloud-two' }];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __resetSummaryWriterHealthForTests();
  writers.calls.length = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47161', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('std-writer', 'ollama-local', ?, ?, '["chat"]', 32000, 0, 1)`).run(STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
  for (const a of AGENTS) {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES (?, ?, 'openai-compatible', 'https://example.invalid/v1', 'api_key', 1)").run(a.provider, a.provider);
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES (?, ?, ?, ?, '["chat"]', 32000, 1, 1)`).run(a.model, a.provider, a.model, a.model);
    db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, ?, ?, 'idle', '{}')").run(a.id, a.id, a.model);
    const ids: string[] = [];
    for (let t = 1; t <= 3; t++) {
      ids.push(insertMessage({ agentId: a.id, role: 'user', lane: 'owner', senderId: 'owner', content: `[${a.id} u${t}] Which bay is the crate for? It matters for the shipment today.`, turnNumber: t }).id);
      ids.push(insertMessage({ agentId: a.id, role: 'assistant', lane: 'owner', turnNumber: t, content: `[${a.id} a${t}] Bay three, after the inspection is done this afternoon.` }).id);
    }
    // A stored summary carrying a platform envelope: the nightly rebuild flags it as contaminated.
    createLeafSummary(a.id, '[SOURCE: PM AGENT POKE] the crate goes to bay three', 40, ids, new Date().toISOString(), new Date().toISOString());
  }
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const writerFor = (agentId: string): string[] => writers.calls.filter((c) => c.content.includes(`[${agentId} `)).map((c) => c.modelId);

describe('the nightly rebuild writes each agent\'s summaries with that agent\'s own model', () => {
  it('no Settings pick: each agent\'s own model, never the small writer', async () => {
    await runSummaryRebuildBatch();
    expect(writerFor('agent-one')).toEqual(['own-one']);
    expect(writerFor('agent-two')).toEqual(['own-two']);
  });

  it('an agent whose model cannot be reached: the small writer, for that agent only', async () => {
    noteDidNotAnswerInTurn('own-two');
    await runSummaryRebuildBatch();
    expect(writerFor('agent-one')).toEqual(['own-one']);
    expect(writerFor('agent-two')).toEqual(['std-writer']);
  });

  it('an explicit Settings pick writes every agent\'s summaries', async () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'own-one')").run();
    await runSummaryRebuildBatch();
    expect(writerFor('agent-one')).toEqual(['own-one']);
    expect(writerFor('agent-two')).toEqual(['own-one']);
  });
});
