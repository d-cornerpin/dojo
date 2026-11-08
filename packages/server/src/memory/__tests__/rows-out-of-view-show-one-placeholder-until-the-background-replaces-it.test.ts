// Rows out of the agent's view are represented one way: a placeholder note, built from stored columns only, in the
// assembled context exactly as written; the background folder later replaces it with a real summary of exactly its
// rows, and the assembled context then carries that summary and no placeholder. Driven through the assembler.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: () => 'archive-1', isDreamerIgnored: () => false, getArchiveHighWaterMark: () => null }));
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'Summary: the depot crew logged the seals on crate 7 and filed the manifests.', toolCalls: [], usage: {} }),
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, hasUncondensedPlaceholders } from '../out-of-view.js';
import { withLock } from '../../db/with-lock.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetSummaryWriterHealthForTests } from '../writer.js';

const AGENT = 'agent-out-of-view';
const WRITER = 'model-out-of-view';
const T0 = Date.UTC(2026, 9, 1, 15, 0, 0);
const db = (): Database.Database => mockDb.current!;
const view = async (): Promise<string> => JSON.stringify((await assembleContext(AGENT, WRITER)).messages);

beforeEach(() => {
  __resetBrakesForTests(); __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-oov', 'Cloud', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
                VALUES (?, 'p-oov', 'writer', 'Writer', 32000, 4096, '["text","tools"]', 1, 0.1, 0.4)`).run(WRITER);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, WRITER);
  for (let t = 1; t <= 6; t++) {
    const ask = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', channel: 'dashboard', turnNumber: t, content: `[u${t}] Check the seal on crate 7.` });
    const reply = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: t, content: `[a${t}] Seal on crate 7 logged.` });
    db().prepare('UPDATE messages SET created_at = ? WHERE seq = ?').run(T0 + t * 120_000, ask.seq);
    db().prepare('UPDATE messages SET created_at = ? WHERE seq = ?').run(T0 + t * 120_000 + 60_000, reply.seq);
  }
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('rows out of view show one placeholder until the background replaces it', () => {
  it('the placeholder renders exactly as stored; the replacement carries the summary and no placeholder', async () => {
    const through = (db().prepare("SELECT seq FROM messages WHERE agent_id = ? AND content LIKE '[a3]%'").get(AGENT) as { seq: number }).seq;
    expect(await withLock(`compact:${AGENT}`, async () => writeUncondensedPlaceholders(AGENT, through))).toBe(6);
    const note = (db().prepare("SELECT content FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").all(AGENT) as Array<{ content: string }>);
    expect(note).toHaveLength(1);
    expect(note[0].content).toMatch(/^\[Not yet condensed\] 6 messages from this agent's own work, 2026-10-01 \d\d:02 UTC \u2013 2026-10-01 \d\d:07 UTC, not yet condensed \u2014 the originals are kept and searchable\.$/);
    expect(await view()).toContain(JSON.stringify(note[0].content).slice(1, -1));

    expect(await replaceUncondensedPlaceholders(AGENT)).toBe(1);
    expect(hasUncondensedPlaceholders(AGENT)).toBe(false);
    const after = await view();
    expect(after).toContain('the depot crew logged the seals on crate 7');
    expect(after).not.toContain('[Not yet condensed]');
  });
});
