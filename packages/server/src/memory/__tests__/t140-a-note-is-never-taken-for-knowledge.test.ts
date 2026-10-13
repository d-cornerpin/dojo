// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 4 — THE THIRD `summaries.kind` IS SAFE EVERYWHERE A SUMMARY IS READ.
//
// Until t140 every summary was `leaf` or `condensed`, and every binary branch over `kind` was
// written assuming two. A not-yet-condensed note (`kind = 'uncondensed'`) stands in for rows the view
// dropped while no summary writer answered: it says only that those rows exist and are kept. It is
// a pointer, not knowledge. This file drives each reader that could mistake it for knowledge or
// mangle it — the embedding write and the vector read, the embedding backfill, the placeholder
// replacement's re-embed, the nightly rebuild, the obligations sweep, expansion — against a real
// note on a migrated DB. (Condensation never folding a note is witnessed in
// `t140-the-out-of-view-fold-never-hangs-or-loses-rows.test.ts`.)
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
const embed = vi.hoisted(() => ({ queued: [] as Array<{ id: string; content: string }>, refreshed: [] as Array<{ id: string; content: string }>, stored: [] as string[] }));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: (_t: string, id: string, _a: string | null, content: string) => { embed.queued.push({ id, content }); },
  refreshEmbedding: (_t: string, id: string, _a: string | null, content: string) => { embed.refreshed.push({ id, content }); },
  storeEmbedding: async (_t: string, id: string) => { embed.stored.push(id); },
}));
vi.mock('../summarize.js', () => ({
  generateSummary: async () => ({ ok: true, text: 'The crew counted the ledger six times; it balanced each time.', tokenCount: 12 }),
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders } from '../uncondensed-placeholder.js';
import { insertEmbeddingIfSourceAlive, embeddingSourceAliveSql } from '../embedding-sources.js';
import { __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';

const AGENT = 'agent-t140-note-knowledge';
const MODEL = 'model-t140-note-knowledge';
const db = (): Database.Database => mockDb.current!;

function aNote(): string {
  const last = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
  expect(writeUncondensedPlaceholders(AGENT, last - 2)).toBeGreaterThan(0);
  return (db().prepare("SELECT id FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { id: string }).id;
}
const vector = (): Buffer => Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

beforeEach(() => {
  embed.queued.length = 0; embed.refreshed.length = 0; embed.stored.length = 0;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-n', 'P', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
                VALUES (?, 'p-n', 'M', 'm', '["text"]', 32000, 4096, 1)`).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Ledger Desk', ?, 'idle', '{}')").run(AGENT, MODEL);
  for (let i = 1; i <= 6; i++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `Ask ${i}: is the ledger balanced today?`, turnNumber: i });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `Reply ${i}: yes, it is balanced to the cent.`, turnNumber: i });
  }
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 — a not-yet-condensed note is never taken for knowledge', () => {
  it.fails('EMBEDDING WRITE: a note is not an embeddable source — the guarded insert writes nothing for it', () => {
    const id = aNote();
    const wrote = insertEmbeddingIfSourceAlive(db(), {
      id: 'emb-note', sourceType: 'summary', sourceId: id, agentId: AGENT, preview: 'x', vector: vector(), dimensions: 4,
    });
    expect(wrote, 'a note was embedded as if it were a summary of what was said').toBe(false);
  });

  it.fails('VECTOR READ: an embedding a note somehow carries (a legacy row) is never served', () => {
    const id = aNote();
    db().prepare(`INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, created_at)
                  VALUES ('emb-legacy', 'summary', ?, ?, 'x', ?, 4, datetime('now'))`).run(id, AGENT, vector());
    const served = db().prepare(`SELECT COUNT(*) AS n FROM embeddings e WHERE ${embeddingSourceAliveSql('e')}`).get() as { n: number };
    expect(served.n).toBe(0);
  });

  it.fails('BACKFILL: the embedding backfill never picks a note up', async () => {
    const id = aNote();
    const { runBackfill } = await import('../backfill.js');
    await runBackfill();
    expect(embed.stored, 'the backfill sent a note to be embedded').not.toContain(id);
  });

  it.fails('REPLACED IN PLACE: when a writer answers, the same row becomes a real summary and THAT text is embedded', async () => {
    const id = aNote();
    await replaceUncondensedPlaceholders(AGENT);
    const row = db().prepare('SELECT kind, content FROM summaries WHERE id = ?').get(id) as { kind: string; content: string };
    expect(row.kind).toBe('leaf');
    expect(row.content).toMatch(/balanced each time/);
    expect(embed.refreshed.map((r) => r.id), 'the real summary was never embedded').toContain(id);
  });

  it('NIGHTLY REBUILD: a note is never flagged for a rebuild (the replacement owns it)', async () => {
    const id = aNote();
    const { findContaminatedSummaries } = await import('../summary-rebuild.js');
    expect(findContaminatedSummaries().map((f) => f.id)).not.toContain(id);
  });

  it('OBLIGATIONS SWEEP: a note\'s text names no work, so the sweep never rewrites it (which would make it a leaf)', async () => {
    const id = aNote();
    const { sweepStoredSummaryObligations } = await import('../summary-obligations.js');
    sweepStoredSummaryObligations({ dryRun: false, agentId: AGENT });
    expect((db().prepare('SELECT kind FROM summaries WHERE id = ?').get(id) as { kind: string }).kind).toBe('uncondensed');
  });

  it('EXPANSION: a note expands to exactly the rows it stands for', async () => {
    const id = aNote();
    const { getDescendantMessages } = await import('../dag.js');
    const linked = (db().prepare('SELECT COUNT(*) AS n FROM summary_messages WHERE summary_id = ?').get(id) as { n: number }).n;
    expect(getDescendantMessages(id).length).toBe(linked);
  });
});
