// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 4 (fence extended to `gateway/routes/memory.ts`) — THE MANUAL SUMMARY WRITERS AND
// THE NOT-YET-CONDENSED NOTE.
//
// The memory routes write summaries by hand: `POST /:agentId/inject` (a memory with no source rows)
// and `PUT /:agentId/summary/:summaryId` (an edit). Every other summary writer obeys one rule
// about placeholder notes: a real summary wins, and only the engine writes a note. Measured at the
// lane's head, the routes broke it from the other side: a summary whose text starts with the
// reserved head IS a placeholder to the engine, so
//   · an injected memory beginning "[Not yet condensed]" was taken for a note with no rows and
//     DELETED by the next placeholder replacement — the owner's own memory, gone;
//   · an edit that kept the head was OVERWRITTEN by the replacement with a model summary.
// And an edit that turns a note into the owner's own words makes it a real summary of those rows,
// which the replacement must then leave alone.
//
// THE DOORS: the real router (`memoryRouter.request`), the real DB, the real replacement.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../memory/embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
  getEmbeddingStatus: () => ({}),
  setEmbeddingConfig: () => undefined,
}));
const writer = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../memory/summarize.js', () => ({
  generateSummary: async () => { writer.calls++; return { ok: true, text: 'A model summary of those rows.', tokenCount: 7 }; },
}));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { memoryRouter } from '../memory.js';
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders } from '../../../memory/uncondensed-placeholder.js';
import { UNCONDENSED_PLACEHOLDER_HEAD } from '../../../memory/uncondensed-head.js';
import { __resetSummaryWriterHealthForTests } from '../../../memory/summary-writer-health.js';

const AGENT = 'agent-t140-manual-memory';
const MODEL = 'model-t140-manual-memory';
const db = (): Database.Database => mockDb.current!;

function call(method: string, path: string, body: unknown): Promise<Response> {
  return memoryRouter.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as Promise<Response>;
}
const summaryContents = (): string[] =>
  (db().prepare('SELECT content FROM summaries WHERE agent_id = ? ORDER BY created_at, id').all(AGENT) as Array<{ content: string }>).map((r) => r.content);

beforeEach(() => {
  writer.calls = 0;
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-m', 'P', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
                VALUES (?, 'p-m', 'M', 'm', '["text"]', 32000, 4096, 1)`).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Ledger Desk', ?, 'idle', '{}')").run(AGENT, MODEL);
  for (let i = 1; i <= 6; i++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `Ask ${i}: is the ledger balanced?`, turnNumber: i });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `Reply ${i}: yes, balanced.`, turnNumber: i });
  }
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 — the manual summary routes never pass a summary off as a placeholder note', () => {
  it('an injected memory that begins with the reserved head is refused, so no replacement can delete it as an empty note', async () => {
    const res = await call('POST', `/${AGENT}/inject`, { content: `${UNCONDENSED_PLACEHOLDER_HEAD} remember: the vault key is in the blue binder.` });
    expect(res.status).toBe(400);
    expect(summaryContents()).toEqual([]);
  });

  it('an ordinary injected memory survives a placeholder replacement untouched', async () => {
    const res = await call('POST', `/${AGENT}/inject`, { content: 'Remember: the ledger closes on Fridays.' });
    expect(res.status).toBe(200);
    await replaceUncondensedPlaceholders(AGENT);
    expect(summaryContents()).toEqual(['Remember: the ledger closes on Fridays.']);
    expect(writer.calls).toBe(0);
  });

  it('an edit that keeps the reserved head is refused, so the replacement can never overwrite the owner\'s words', async () => {
    const last = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    expect(writeUncondensedPlaceholders(AGENT, last - 2)).toBeGreaterThan(0);
    const id = (db().prepare('SELECT id FROM summaries WHERE agent_id = ?').get(AGENT) as { id: string }).id;
    const res = await call('PUT', `/${AGENT}/summary/${id}`, { content: `${UNCONDENSED_PLACEHOLDER_HEAD} my own notes about the ledger.` });
    expect(res.status).toBe(400);
  });

  it('an edit that turns a note into the owner\'s own words makes it a real summary of those rows, which the replacement leaves alone', async () => {
    const last = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
    writeUncondensedPlaceholders(AGENT, last - 2);
    const id = (db().prepare('SELECT id FROM summaries WHERE agent_id = ?').get(AGENT) as { id: string }).id;
    const res = await call('PUT', `/${AGENT}/summary/${id}`, { content: 'The owner checked the ledger six times; it balanced each time.' });
    expect(res.status).toBe(200);
    await replaceUncondensedPlaceholders(AGENT);
    expect(summaryContents()).toEqual(['The owner checked the ledger six times; it balanced each time.']);
    expect(writer.calls).toBe(0);
  });
});
