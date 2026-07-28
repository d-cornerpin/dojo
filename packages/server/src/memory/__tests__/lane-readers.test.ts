// PHASE-1 T5 — the reader side of the unified table.
//
// Everything here runs against the REAL migration chain in an in-memory database, for the
// same reason message-store.test.ts does: the subject is what the readers see, and a
// hand-built fixture would let a wrong projection pass unnoticed.
//
// THE DEFECT THIS TASK CLOSES. Before the unified table, agent-to-agent traffic lived in a
// second physical table with no FTS index and no summaries, so `history_search` could not
// see it at all and every model-facing tail had to UNION two tables and dedup with an
// anti-join to reach it. That is the "20k invisible" class: an agent could hold thousands of
// rows of coordination history it was structurally unable to recall. The fix is one table
// with a `lane` column — agent-recall surfaces read all lanes, the human-facing
// `chat_messages` view reads `lane='owner'` and nothing else.
//
// The three blocks below are the three properties T5 owes, and each was RED against the
// two-table readers before the rewrite (transcript in the task report):
//   1. AGENT RECALL COVERS A2A — including through FTS, which the second table never had.
//   2. ONE TAIL QUERY, ORDERED BY `seq` — insertion order, not a second-granular TEXT clock
//      that the engine's own re-home path deliberately pushes out of lockstep.
//   3. NO READER EMITS A FOREIGN TABLE'S ROWID — the vault high-water is a `messages` key,
//      and mixing a second table's rowid space into it silently skips real history.

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

import { insertMessage, insertEngineEvent } from '../message-store.js';
import { getRecentMessages, getMessagesOutsideFreshTail, getMessagesByIds } from '../store.js';
import { recallRecentThread } from '../recall.js';
import { memoryGrep } from '../retrieval.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-lane-reader';
const PEER = 'agent-lane-peer';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const ins = mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')");
  ins.run(AGENT, 'Lane Reader');
  ins.run(PEER, 'Lane Peer');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** A mixed history in the shape the platform actually writes it: an owner conversation,
 *  a peer's inbound A2A, the agent's own A2A output, and an engine coordination row. */
function seedMixedHistory(): { ownerIds: string[]; a2aIds: string[]; eventIds: string[] } {
  const owner1 = insertMessage({
    agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard',
    content: 'the loft key is under the third planter',
  });
  const owner2 = insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', channel: 'dashboard',
    content: 'noted, third planter',
  });
  const peerIn = insertMessage({
    agentId: AGENT, role: 'user', lane: 'a2a',
    sourceAgentId: PEER, a2aThreadId: 'thread-lane-1', a2aIntent: 'ASSIGN',
    a2aRequiresResponse: true,
    content: '[A2A:ASSIGN thread:thread-lane-1 from:Lane Peer] audit the burnwood ledger',
  });
  const ownOut = insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'a2a',
    content: 'starting the burnwood ledger audit now',
  });
  const engine = insertEngineEvent({
    agentId: AGENT, content: '[Engine] scheduled sweep fired', originIntent: 'scheduler',
  });
  return {
    ownerIds: [owner1.id, owner2.id],
    a2aIds: [peerIn.id, ownOut.id],
    eventIds: [engine.id],
  };
}

// ── 1. Agent recall covers agent-to-agent history; the human view never does ──

describe('agent recall covers the a2a lane (the 20k-invisible class)', () => {
  it('the model-facing tail carries owner, a2a and engine rows alike', () => {
    const seeded = seedMixedHistory();
    const tail = getRecentMessages(AGENT, 50);
    const ids = tail.map((m) => m.id);
    for (const id of [...seeded.ownerIds, ...seeded.a2aIds, ...seeded.eventIds]) {
      expect(ids, `assembled tail dropped ${id}`).toContain(id);
    }
  });

  it('recall_recent_thread surfaces a2a content', () => {
    seedMixedHistory();
    const out = recallRecentThread(AGENT, {
      turnCount: 20, includeToolCalls: true, includeToolResults: true, scope: 'all',
    });
    expect(out).toContain('burnwood ledger');
    expect(out).toContain('third planter');
  });

  it('history_search finds a2a content through FTS — the second table never had an index', () => {
    seedMixedHistory();
    const hits = memoryGrep(AGENT, { pattern: 'burnwood', scope: 'messages' });
    expect(hits).toContain('burnwood');
    expect(hits).not.toContain('No results found');
  });

  it('the chat_messages view shows the owner lane and nothing else', () => {
    const seeded = seedMixedHistory();
    const rows = mockDb.current!.prepare(
      'SELECT id, lane FROM chat_messages WHERE agent_id = ?',
    ).all(AGENT) as Array<{ id: string; lane: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([...seeded.ownerIds].sort());
    expect(rows.every((r) => r.lane === 'owner')).toBe(true);
  });
});

// ── 2. One tail query, ordered by seq ──
//
// `created_at` is second-granular epoch-ms INTEGER (T6b, mig 131), and the engine's re-home
// (message-store.rehomeUndeliveredCreatedAt, D-A step 4) deliberately pushes a row's
// created_at FORWARD across a session reset while its insertion key stays put. A tail
// ordered by the clock therefore reports a row that was written first as if it arrived
// last. `seq` is the insertion order and cannot drift.

describe('one tail query, ordered by seq', () => {
  it('a re-homed row keeps its insertion position', () => {
    const first = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'first' });
    const second = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'second' });
    const third = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'third' });

    // Exactly what rehomeUndeliveredCreatedAt does to a fired-but-undelivered event.
    mockDb.current!.prepare("UPDATE messages SET created_at = (CAST(strftime('%s','now','+1 hour') AS INTEGER) * 1000) WHERE id = ?")
      .run(first.id);

    const tail = getRecentMessages(AGENT, 50);
    expect(tail.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
  });

  it('id-keyed resolution (summary sources) is in insertion order too', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'alpha' });
    const b = insertMessage({ agentId: AGENT, role: 'assistant', lane: 'a2a', content: 'bravo' });
    const c = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: 'charlie' });
    mockDb.current!.prepare("UPDATE messages SET created_at = (CAST(strftime('%s','now','+1 hour') AS INTEGER) * 1000) WHERE id = ?")
      .run(a.id);

    const rows = getMessagesByIds([c.id, a.id, b.id]);
    expect(rows.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });
});

// ── 3. No reader emits a foreign table's rowid ──
//
// vault/archive.ts turns `Message.rowid` into `vault_conversations.latest_rowid`, the
// per-agent archive high-water. A reader that mixes a SECOND table's rowid space into that
// array can hand the vault a high-water far above any real message, and every later archive
// then skips genuine history — a silent loss in the Dreamer feed. One table, one keyspace.

describe('the archive high-water reads one keyspace', () => {
  it('every rowid a tail loader emits is a seq in messages', () => {
    for (let i = 0; i < 8; i++) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: `owner ${i}` });
    }
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: PEER,
      a2aThreadId: 'thread-lane-2', a2aIntent: 'QUESTION', content: 'peer asks something',
    });

    // A pre-cutover row still sitting in the legacy inter-agent table, with a rowid far
    // above anything in `messages`. It is OLD, so it lands outside the fresh tail — the
    // exact slice the vault archives. Nothing may lift that number into the messages
    // keyspace, because `latest_rowid` is compared against `messages.seq` forever after.
    mockDb.current!.prepare(
      `INSERT INTO inter_agent_messages (rowid, id, agent_id, role, content, source_agent_id, created_at)
       VALUES (999999, 'legacy-ia-row', ?, 'user', 'legacy peer row', ?, datetime('now', '-1 hour'))`,
    ).run(AGENT, PEER);

    const maxSeq = (mockDb.current!.prepare('SELECT MAX(seq) s FROM messages').get() as { s: number }).s;
    const outside = getMessagesOutsideFreshTail(AGENT, 2);
    const rowids = outside.map((m) => m.rowid).filter((r): r is number => typeof r === 'number');

    expect(rowids.length).toBeGreaterThan(0);
    for (const r of rowids) {
      expect(r, 'a foreign table rowid reached the messages high-water').toBeLessThanOrEqual(maxSeq);
    }
  });
});
