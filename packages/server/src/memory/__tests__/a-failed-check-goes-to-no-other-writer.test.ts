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
const writers = vi.hoisted(() => ({ calls: [] as string[], fine: new Set<string>() }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { modelId: string }) => {
    writers.calls.push(p.modelId);
    const fine = [...writers.fine].some((marker) => (p as unknown as { messages: Array<{ content: string }> }).messages[0].content.includes(marker));
    return { content: fine ? 'The owner asked which bay; the agent answered.' : 'PENDING: the agent still owes the crate.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
  effectiveContextWindow: (d: number) => d, resolveNumCtx: () => ({ effective: null }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, hasUncondensedPlaceholders } from '../out-of-view.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { generateSummary } from '../summarize.js';
import { sanitizeMessagesOnModelChange } from '../../agent/model-switch.js';

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
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A', 'paid-own', 'idle', '{}')").run(AGENT);
  for (let t = 1; t <= 6; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] Bay ${t}, after inspection.` });
  }
  writers.fine.clear();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { body?: string }) => {
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    const bad = state.summary.includes('PENDING') ? 0.93 : 0.04;
    return Response.json({ answers: { stated_current: { noul: bad } } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('the placeholder replacer and a failed check', () => {
  // v3.5 field fix 3 (edited: the writer was the Settings pick 'writer-small', and the walk was not to reach the agent's
  // own model): there is no pick, so the agent's own model writes first; the walk must not reach the next writer.
  it('stops at the writer whose summary failed twice; the next writer is never asked', async () => {
    const maxSeq = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    expect(writeUncondensedPlaceholders(AGENT, maxSeq)).toBeGreaterThan(0);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writers.calls).toEqual(['paid-own', 'paid-own']);   // the write and the one rewrite
    expect(hasUncondensedPlaceholders(AGENT)).toBe(true);      // the span is left as it is
    expect(db().prepare("SELECT writer_model_id, outcome FROM summary_checks").all()).toEqual([{ writer_model_id: 'paid-own', outcome: 'not_kept' }]);
  });
});

describe('fix round 2 (ORCHESTRATOR RULING): a span that failed its check', () => {
  // t269: a span is longer than the summaries scripted for it (a summary longer than its input is never kept).
  const rows = (tag: string): string => `${tag} rows: ${'the owner asked which bay the next crate is for, and the agent answered. '.repeat(3)}`;
  const span = { content: rows('SPAN-A'), depth: 0, targetTokens: 400, agentId: AGENT, spanIds: ['msg-1', 'msg-2'] };

  it('(i)+(ii) is handed to no other writer by any path, and not retried by the same writer, until something changes', async () => {
    expect((await generateSummary({ ...span, modelId: 'writer-small' })).ok).toBe(false);
    expect(writers.calls).toEqual(['writer-small', 'writer-small']);
    writers.calls.length = 0;
    const again = await generateSummary({ ...span, modelId: 'writer-small' });
    const elsewhere = await generateSummary({ ...span, modelId: 'paid-own' });
    expect(again.ok === false && again.checkFailed).toBe(true);
    expect(elsewhere.ok === false && elsewhere.checkFailed).toBe(true);
    expect(writers.calls).toEqual([]);   // nobody was dialled
  });

  // v3.5 field fix 3 (edited: "or the owner changing the summary writer", a setting the owner ruled must not exist).
  it('(ii) a new row joining the span lets it be tried again', async () => {
    await generateSummary({ ...span, modelId: 'writer-small' });
    writers.calls.length = 0;
    await generateSummary({ ...span, spanIds: ['msg-1', 'msg-2', 'msg-3'], modelId: 'writer-small' });
    expect(writers.calls.length).toBeGreaterThan(0);
  });

  it('each failed row waits under the agent\'s own model; a span summarized after all leaves none', async () => {
    const refused = (): string[] => (db().prepare("SELECT key FROM healer_state WHERE scope = 'writer_wait.check-failed' ORDER BY key").all() as Array<{ key: string }>).map((r) => r.key);
    await generateSummary({ ...span, modelId: 'writer-small' });
    expect(refused()).toEqual([`${AGENT}|paid-own|msg-1`, `${AGENT}|paid-own|msg-2`]);
    await generateSummary({ ...span, spanIds: ['msg-9'], modelId: 'paid-own' });
    expect(refused()).toEqual([`${AGENT}|paid-own|msg-1`, `${AGENT}|paid-own|msg-2`, `${AGENT}|paid-own|msg-9`]);
    writers.fine.add('SPAN-B');
    await generateSummary({ ...span, content: rows('SPAN-B'), spanIds: ['msg-9', 'msg-10'], modelId: 'paid-own' });
    expect(refused()).toEqual([`${AGENT}|paid-own|msg-1`, `${AGENT}|paid-own|msg-2`]);
  });

  it('a model switched away and back does not hand the same writer the span it already failed', async () => {
    const maxSeq = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    writeUncondensedPlaceholders(AGENT, maxSeq);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writers.calls).toEqual(['paid-own', 'paid-own']);
    for (const model of ['writer-small', 'paid-own']) {
      db().prepare('UPDATE agents SET model_id = ? WHERE id = ?').run(model, AGENT);
      sanitizeMessagesOnModelChange(AGENT);
    }
    writers.calls.length = 0;
    await replaceUncondensedPlaceholders(AGENT);
    expect(writers.calls).toEqual([]);
  });

  it('(iii) never blocks the newer placeholders of the agent: each span is its own', async () => {
    const ids = (db().prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY seq').all(AGENT) as Array<{ id: string }>).map((r) => r.id);
    // Two placeholders: the older one's rows always fail, the newer one's rows summarise fine.
    writeUncondensedPlaceholders(AGENT, (db().prepare('SELECT seq FROM messages WHERE id = ?').get(ids[5]) as { seq: number }).seq);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: '[u9] FINE-MARK a later question', turnNumber: 9 });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: 9, content: '[a9] FINE-MARK a later answer' });
    writers.fine.add('FINE-MARK');
    const latest = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    writeUncondensedPlaceholders(AGENT, latest);
    expect((db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n).toBe(2);
    await replaceUncondensedPlaceholders(AGENT);
    expect((db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n).toBe(1);
  });
});
