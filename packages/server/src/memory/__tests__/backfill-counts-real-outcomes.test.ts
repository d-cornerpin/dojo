// ════════════════════════════════════════════════════════════════════════════════════════
// THE BACKFILL COUNTS WHAT LANDED, NOT WHAT RETURNED.
//
// `storeEmbedding` is best-effort: it swallows every failure and returns void, so an item that
// came back void left NO row. Counting the absence of a throw counts that item as embedded when
// nothing was written, and the same un-embedded rows come round again on the next run. The count
// has to read the row out of the table instead.
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

// The ids whose row actually lands. The mock writes a row only for these and otherwise does
// nothing at all — exactly the swallowed-failure shape of the real `storeEmbedding`.
const okIds = vi.hoisted(() => new Set<string>());
vi.mock('../embeddings.js', () => {
  let n = 0;
  return {
    storeEmbedding: async (sourceType: string, sourceId: string, agentId: string | null, content: string) => {
      if (!okIds.has(sourceId)) return;
      mockDb.current!.prepare(
        `INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, embedding_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 4, 'ollama:nomic-embed-text', datetime('now'))`,
      ).run(`emb-${++n}`, sourceType, sourceId, agentId, content.slice(0, 200), Buffer.from(new Float32Array([1, 0, 0, 0]).buffer));
    },
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { runBackfill } from '../backfill.js';

const AGENT = 'agent-backfill-counts';
const MODEL = 'model-backfill-counts';
const db = (): Database.Database => mockDb.current!;

let messageIds: string[] = [];

beforeEach(() => {
  okIds.clear();
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p-n', 'P', 'openai-compatible', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
                VALUES (?, 'p-n', 'M', 'm', '["text"]', 32000, 4096, 1)`).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'Ledger Desk', ?, 'idle', '{}')").run(AGENT, MODEL);
  messageIds = [];
  for (let i = 1; i <= 4; i++) {
    const p = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `Message ${i}: is the ledger balanced today?`, turnNumber: i });
    messageIds.push(p.id);
  }
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('backfill counts the rows that landed, not the calls that returned', () => {
  it('counts 3 embedded and 1 failed when 3 of the 4 rows land', async () => {
    okIds.add(messageIds[0]);
    okIds.add(messageIds[1]);
    okIds.add(messageIds[2]);
    expect(await runBackfill()).toEqual({ completed: 3, failed: 1, total: 4 });
  });

  it('counts all 4 failed when no row lands', async () => {
    expect(await runBackfill()).toEqual({ completed: 0, failed: 4, total: 4 });
  });

  it('never picks a row too short to embed once its padding is trimmed', async () => {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `ok${' '.repeat(12)}\n\n\t${' '.repeat(12)}`, turnNumber: 5 });
    for (const id of messageIds) okIds.add(id);
    expect(await runBackfill()).toEqual({ completed: 4, failed: 0, total: 4 });
  });

  it('counts all 4 embedded when every row lands', async () => {
    for (const id of messageIds) okIds.add(id);
    expect(await runBackfill()).toEqual({ completed: 4, failed: 0, total: 4 });
  });
});
