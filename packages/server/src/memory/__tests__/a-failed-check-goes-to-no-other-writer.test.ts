// v3.5 fix round 1 (B4, I-B4-1) — A SUMMARY THAT FAILS ITS CHECK AFTER THE ONE REWRITE IS NOT SENT TO ANY
// OTHER WRITER. A failed check is a verdict on this span, not a writer that stopped answering, so the
// placeholder replacer must not walk on to the next writer (it ended on the agent's own paid model).
// The span is left as it is this time (its rows kept) and the writer is reported. The writers and the
// decision model are scripted.
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
const writers = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    writers.calls.push(p.modelId);
    return { content: 'INVENTED: the crate was shipped and the task is closed.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, hasUncondensedPlaceholders } from '../uncondensed-placeholder.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-check-walk';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  writers.calls.length = 0;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47125', 'none', 1)").run();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('paid', 'Paid', 'openai-compatible', 'http://127.0.0.1:47126', 'api_key', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('writer-small', 'ollama-local', 'w', 'w', '[\"chat\"]', 32000, 0, 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('paid-own', 'paid', 'p', 'p', '[\"chat\"]', 200000, 3, 1)").run();
  db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'writer-small')").run();
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A', 'paid-own', 'idle', '{}')").run(AGENT);
  for (let t = 1; t <= 6; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] Bay ${t}, after inspection.` });
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answers: { invented: { noul: 0.93 }, dropped: { noul: 0.05 }, stated_current: { noul: 0.05 } } })));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the placeholder replacer and a failed check', () => {
  it('stops at the writer whose summary failed twice; the agent\'s own paid model is never asked', async () => {
    const maxSeq = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    expect(writeUncondensedPlaceholders(AGENT, maxSeq)).toBeGreaterThan(0);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writers.calls).toEqual(['writer-small', 'writer-small']);   // the write and the one rewrite
    expect(hasUncondensedPlaceholders(AGENT)).toBe(true);              // the span is left as it is
    expect(db().prepare("SELECT writer_model_id, outcome FROM summary_checks").all()).toEqual([{ writer_model_id: 'writer-small', outcome: 'not_kept' }]);
  });
});
