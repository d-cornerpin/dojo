// PHASE-1 T7 — the DERIVED stores on one keyspace.
//
// Four stores are derived from `messages` and every one of them still straddled the
// two-store world: the full-text index, the meaning-based lookup (embeddings), the
// summary→message links, and the vault's archival high-waters. This file is the guard
// for what "one keyspace" has to mean for each of them.
//
// Everything runs against the REAL migration chain in an in-memory database, for the same
// reason message-store.test.ts and lane-readers.test.ts do: the subject is what the
// DATABASE enforces and what the readers actually see, and a hand-built fixture would let
// a wrong constraint or a dead repair path pass unnoticed.
//
// The four blocks below are the four properties T7 owes:
//   1. THE SEARCH INDEX COVERS EVERY LANE, AND ITS REPAIR PATH ACTUALLY REPAIRS.
//   2. ONE ARCHIVAL HIGH-WATER, in the same keyspace it is compared against.
//   3. SUMMARY LINKS POINT AT REAL MESSAGES — and compaction still cannot be broken by a
//      message that vanished underneath it (the 2026-07-06 mig-103 incident class).
//   4. SUMMARIES ARE EMBEDDED AT CREATION and reachable by meaning.

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

// The embedding backend is a network call. Everything here is about WHICH rows reach the
// index and whether they come back, never about the vectors themselves, so the backend is
// stubbed to a deterministic vector and `queueEmbedding` is spied on directly.
const embedCalls: Array<{ sourceType: string; sourceId: string; agentId: string | null; content: string }> = [];
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: (sourceType: string, sourceId: string, agentId: string | null, content: string) => {
    embedCalls.push({ sourceType, sourceId, agentId, content });
  },
  storeEmbedding: async () => { /* not exercised here */ },
  refreshEmbedding: () => { /* not exercised here */ },
}));

import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { createLeafSummary, createCondensedSummary, getSummarySourceMessages } from '../dag.js';
import { memoryGrep } from '../retrieval.js';
import { vectorSearch } from '../vector-search.js';
import { archiveAgentConversation, getArchiveHighWaterMark } from '../../vault/archive.js';
import { archiveConversation } from '../../vault/store.js';
import { deleteNonSystemForAgent } from '../message-store.js';

const AGENT = 'agent-derived';
const PEER = 'agent-derived-peer';

beforeEach(() => {
  embedCalls.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  const ins = mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')");
  ins.run(AGENT, 'Derived Stores');
  ins.run(PEER, 'Derived Peer');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const db = (): Database.Database => mockDb.current!;
const one = <T>(sql: string, ...params: unknown[]): T => db().prepare(sql).get(...params) as T;

/** Owner conversation + inbound peer A2A + the agent's own A2A output + an engine row —
 *  the shape the platform actually writes. */
function seedMixedHistory(): { owner: string; peerIn: string; ownOut: string } {
  const owner = insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard',
    content: 'the spare kayak paddle is behind the marmalade crates',
  });
  const peerIn = insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: PEER,
    a2aThreadId: 'thread-derived-1', a2aIntent: 'ASSIGN', a2aRequiresResponse: true,
    content: '[A2A:ASSIGN thread:thread-derived-1 from:Derived Peer] reconcile the harbourmaster ledger',
  });
  // Deliberately does NOT repeat "harbourmaster": that token belongs to the inbound peer
  // row alone, so the drift test below can prove ONE row left the index.
  const ownOut = insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'a2a',
    content: 'starting that reconciliation now',
  });
  return { owner: owner.id, peerIn: peerIn.id, ownOut: ownOut.id };
}

// ── 1. The search index covers every lane, and its repair path actually repairs ──
//
// Migration 127 rebuilt `messages_fts` over the unified table, so a2a rows are indexed for
// the first time. What was NOT true is the boot-time repair: `messages_fts` is an fts5
// EXTERNAL-CONTENT table, and on an external-content table a bare `SELECT ... FROM
// messages_fts` reads through to the content table. So the old probe
// (`COUNT(*) FROM messages_fts` vs `COUNT(*) FROM messages`, then
// `INSERT ... WHERE rowid NOT IN (SELECT rowid FROM messages_fts)`) compares `messages`
// against itself: it reports parity while the index is genuinely missing rows, and its
// repair INSERT selects nothing. Measured on a VACUUM INTO copy of the live box before
// this test was written. A search index whose self-heal cannot fire is a dead guard.

describe('the search index runs on one keyspace', () => {
  it('history_search reaches every lane, not just the owner conversation', () => {
    seedMixedHistory();
    const a2aHits = memoryGrep(AGENT, { pattern: 'harbourmaster', scope: 'messages' });
    expect(a2aHits).toContain('harbourmaster');
    expect(a2aHits).not.toContain('No results found');

    const ownerHits = memoryGrep(AGENT, { pattern: 'marmalade', scope: 'messages' });
    expect(ownerHits).toContain('marmalade');
  });

  it('a row missing from the index is DETECTED and REPAIRED on the next boot', () => {
    const seeded = seedMixedHistory();
    const target = one<{ rowid: number; content: string }>(
      'SELECT seq AS rowid, content FROM messages WHERE id = ?', seeded.peerIn,
    );

    // Genuine drift, produced the way it actually happens: the row is in `messages` but
    // its index entry is gone (a bulk copy performed with the triggers dropped, an fts5
    // shadow-table loss). Not a simulation of the symptom — the symptom itself.
    db().prepare("INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', ?, ?)")
      .run(target.rowid, target.content);
    // NB: memoryGrep's not-found message quotes the pattern back, so `toContain('harbourmaster')`
    // is true for a MISS as well as a hit. The assertion has to be the found-marker.
    expect(memoryGrep(AGENT, { pattern: 'harbourmaster', scope: 'messages' }))
      .toContain('No results found');

    // The boot path. Every migration is already recorded, so this is exactly the
    // no-pending-work boot that the FTS repair region exists to serve.
    runMigrations();

    const repaired = memoryGrep(AGENT, { pattern: 'harbourmaster', scope: 'messages' });
    expect(repaired).not.toContain('No results found');
    expect(repaired).toContain('RAW MESSAGES');
    expect(repaired).toContain(seeded.peerIn.slice(0, 8));
  });

  it('the repair leaves an already-consistent index untouched', () => {
    seedMixedHistory();
    const before = one<{ c: number }>(
      "SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'harbourmaster'",
    ).c;
    runMigrations();
    const after = one<{ c: number }>(
      "SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'harbourmaster'",
    ).c;
    expect(after).toBe(before);
  });
});

// ── 2. One archival high-water ──
//
// T5 deleted the second archive arm; the SCHEMA still carried its high-water column.
// `vault_conversations.latest_ia_rowid` was the rowid of a SECOND table's independent
// sequence. Two columns holding "how far have I archived" in two different keyspaces is
// the shape that let a foreign rowid be persisted as the messages-space high-water, after
// which every later archive silently skips real history (T5's AS-BUILT 3).

describe('the vault has ONE archival high-water', () => {
  it('vault_conversations carries no second-keyspace high-water column', () => {
    const cols = (db().prepare('PRAGMA table_info(vault_conversations)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('latest_rowid');
    expect(cols, 'a second high-water column is a second keyspace').not.toContain('latest_ia_rowid');
  });

  it('a never-archived agent archives everything once, then only the new tail', () => {
    for (let i = 0; i < 4; i++) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: `first batch ${i}` });
    }
    expect(getArchiveHighWaterMark(AGENT)).toBeNull();

    const firstId = archiveAgentConversation(AGENT, true);
    expect(firstId).not.toBeNull();
    const hw = getArchiveHighWaterMark(AGENT);
    const maxSeq = one<{ s: number }>('SELECT MAX(seq) s FROM messages WHERE agent_id = ?', AGENT).s;
    expect(hw).toBe(maxSeq);

    // Nothing new: a forced re-archive must copy nothing rather than duplicate history.
    expect(archiveAgentConversation(AGENT, true)).toBeNull();

    const fresh = insertMessage({ agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: PEER, content: 'a new peer line' });
    const secondId = archiveAgentConversation(AGENT, true);
    expect(secondId).not.toBeNull();
    const second = one<{ messages: string; latest_rowid: number }>(
      'SELECT messages, latest_rowid FROM vault_conversations WHERE id = ?', secondId,
    );
    expect(JSON.parse(second.messages)).toHaveLength(1);
    expect(second.latest_rowid).toBe(fresh.seq);
  });

  it('the high-water an archive persists is a seq in messages', () => {
    for (let i = 0; i < 3; i++) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: `line ${i}` });
    }
    archiveAgentConversation(AGENT, true);
    const maxSeq = one<{ s: number }>('SELECT MAX(seq) s FROM messages').s;
    const rows = db().prepare(
      'SELECT latest_rowid FROM vault_conversations WHERE agent_id = ? AND latest_rowid IS NOT NULL',
    ).all(AGENT) as Array<{ latest_rowid: number }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.latest_rowid).toBeLessThanOrEqual(maxSeq);
  });

  it('archiveConversation takes one high-water and nothing else', () => {
    const id = archiveConversation({
      agentId: AGENT, messages: [], messageCount: 0, tokenCount: 0,
      earliestAt: '2026-01-01 00:00:00', latestAt: '2026-01-01 00:00:01', latestRowid: 7,
    });
    expect(one<{ latest_rowid: number }>('SELECT latest_rowid FROM vault_conversations WHERE id = ?', id).latest_rowid).toBe(7);
    // The second high-water is gone from the writer, not merely left unused: a parameter
    // nothing passes is how the second keyspace would quietly come back.
    const src = archiveConversation.toString();
    expect(src).not.toContain('latestIaRowid');
    expect(src).not.toContain('latest_ia_rowid');
  });
});

// ── 3. Summary links point at real messages ──
//
// Migration 103 removed `summary_messages.message_id REFERENCES messages(id)` because
// agent-to-agent rows had moved to a second table with their own ids, so a legitimate
// compaction chunk contained ids the constraint rejected — every such compaction failed,
// the context never shrank, and reactive compaction re-fired on every turn. One table
// means the constraint is correct again. What must NOT come back with it is that incident:
// a link whose message vanished underneath the summarizer must never take the whole leaf
// summary down with it.

describe('summary links point at real messages', () => {
  it('a link to a message that does not exist is REFUSED by the database', () => {
    const s = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'real message' });
    db().prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, descendant_count, created_at)
                  VALUES ('sum-fk-probe', ?, 0, 'leaf', 'x', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:01', 1, datetime('now'))`).run(AGENT);
    // The good one is accepted...
    db().prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)').run('sum-fk-probe', s.id);
    // ...and the dangling one is not.
    expect(() =>
      db().prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)')
        .run('sum-fk-probe', 'no-such-message-id'),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('compaction still succeeds when a message vanished underneath it (the mig-103 class)', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'chunk line one' });
    const b = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'a2a', content: 'chunk line two' });

    // The summarizer's LLM call is awaited between reading the chunk and writing the
    // summary. A reset_session (or the PM prune) inside that window deletes rows the
    // chunk still names. Under a bare FK the link INSERT throws, the whole leaf summary
    // rolls back, and compaction re-fires forever — the exact 2026-07-06 incident.
    db().prepare('DELETE FROM messages WHERE id = ?').run(b.id);

    const summary = createLeafSummary(
      AGENT, 'the compressed chunk', 12, [a.id, b.id],
      '2026-01-01 00:00:00', '2026-01-01 00:00:05',
    );
    expect(summary.id).toBeTruthy();
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM summaries WHERE id = ?', summary.id).c).toBe(1);

    // The link that CAN resolve is recorded; the one that cannot is not invented.
    const linked = (db().prepare('SELECT message_id FROM summary_messages WHERE summary_id = ?')
      .all(summary.id) as Array<{ message_id: string }>).map((r) => r.message_id);
    expect(linked).toEqual([a.id]);
    expect(getSummarySourceMessages(summary.id).map((m) => m.id)).toEqual([a.id]);
  });

  it('deleting a message takes its links with it, so danglers cannot accumulate', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'kept line' });
    const b = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'doomed line' });
    const summary = createLeafSummary(AGENT, 'compressed', 9, [a.id, b.id], '2026-01-01 00:00:00', '2026-01-01 00:00:05');
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM summary_messages WHERE summary_id = ?', summary.id).c).toBe(2);

    // reset_session's wipe. It must not throw, and it must not leave a dangling link.
    expect(() => deleteNonSystemForAgent(AGENT)).not.toThrow();

    expect(one<{ c: number }>('SELECT COUNT(*) c FROM summary_messages WHERE summary_id = ?', summary.id).c).toBe(0);
    expect(one<{ c: number }>(
      'SELECT COUNT(*) c FROM summary_messages sm LEFT JOIN messages m ON m.id = sm.message_id WHERE m.id IS NULL',
    ).c).toBe(0);
  });

  it('a summary links each message once, however often the chunk names it', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'repeated line' });
    const summary = createLeafSummary(AGENT, 'compressed', 4, [a.id, a.id, a.id], '2026-01-01 00:00:00', '2026-01-01 00:00:05');
    expect(one<{ c: number }>('SELECT COUNT(*) c FROM summary_messages WHERE summary_id = ?', summary.id).c).toBe(1);
  });
});

// ── 4. Summaries are embedded at creation and reachable by meaning ──

describe('compressed history is reachable by meaning', () => {
  it('a leaf summary is queued for embedding the moment it is created', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'a line worth compressing' });
    const summary = createLeafSummary(AGENT, 'the compressed body', 11, [a.id], '2026-01-01 00:00:00', '2026-01-01 00:00:05');
    expect(embedCalls).toContainEqual({
      sourceType: 'summary', sourceId: summary.id, agentId: AGENT, content: 'the compressed body',
    });
  });

  it('a condensed summary is too — depth is not a reason to be unsearchable', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'a line worth compressing' });
    const leaf = createLeafSummary(AGENT, 'leaf body', 11, [a.id], '2026-01-01 00:00:00', '2026-01-01 00:00:05');
    embedCalls.length = 0;
    const condensed = createCondensedSummary(AGENT, 'condensed body', 8, [leaf.id], 1, '2026-01-01 00:00:00', '2026-01-01 00:00:05');
    expect(embedCalls).toContainEqual({
      sourceType: 'summary', sourceId: condensed.id, agentId: AGENT, content: 'condensed body',
    });
  });

  it('meaning-based search returns a summary hit', async () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'the harbour ledger reconciliation' });
    const summary = createLeafSummary(AGENT, 'the agent reconciled the harbour ledger', 14, [a.id], '2026-01-01 00:00:00', '2026-01-01 00:00:05');

    // What `storeEmbedding` writes, written directly so the assertion is about the SEARCH
    // and not about a network backend.
    const vec = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
    db().prepare(`INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, created_at)
                  VALUES ('emb-sum', 'summary', ?, ?, ?, ?, 4, datetime('now'))`)
      .run(summary.id, AGENT, 'the agent reconciled the harbour ledger', vec);

    const hits = await vectorSearch('harbour ledger', AGENT, {
      sourceType: 'all', queryEmbedding: new Float32Array([1, 0, 0, 0]),
    });
    expect(hits.map((h) => h.sourceId)).toContain(summary.id);
    expect(hits.find((h) => h.sourceId === summary.id)?.sourceType).toBe('summary');
  });
});
