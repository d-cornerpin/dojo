// RC-14: deterministic awaiting-reply latch in deliverA2AMessage.
//
// A wake-intent re-ask (QUESTION/ASSIGN/BLOCK) on a thread whose most recent
// delivery was THIS sender's own, still-unanswered wake-intent is dropped with
// AWAITING_REPLY while the receiver still owes a reply and we are inside a
// 15-minute cooldown. These tests stand up an in-memory DB + the minimal mock
// set (same harness shape as squad-coordination.test.ts) and drive the real
// deliverA2AMessage flow so the SQL gate and its carve-outs are locked down.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// The latch is embedding-free; embeddings only matter for the semantic-dedup
// step that the non-latched (delivered) cases fall through to. Return a stable
// vector so cosine similarity is deterministic and never trips dedup here.
vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => {
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i++) v[i] = i + 1;
    return v;
  }),
  queueEmbedding: vi.fn(),
}));

vi.mock('../../gateway/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  isPMAgent: () => false,
  isHealerAgent: () => false,
  isDreamerAgent: () => false,
  getOwnerName: () => 'Owner',
  getPrimaryAgentId: () => 'primary',
}));

const handleMessage = vi.fn(async () => {});
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage }),
}));

// The persisted row is the sole delivery vehicle; for these tests we only care about the
// latch decision, so a stub keeps the delivered cases past the FA-C4 persist guard without a
// full messages INSERT.
//
// T10 re-pointed this from the deleted shim `memory/interagent.js`, and the stub set had to
// GROW by one to stay honest: that shim did two things behind a single call — resolve the
// peer-A2A conversation and persist the row — and both now happen at the call site in
// a2a-transport.ts. This fixture has no `conversations` table (conversation identity is not
// what the latch decides), so the resolver is stubbed alongside the write. Everything else in
// the writer module is the REAL implementation: `setConvKeyByRowid` and the engine-event
// writer run against the fixture, which is what they did before through the shim.
//
// The stub's shape follows the real contract: `insertMessageIfAbsent` returns the persisted
// row, or `null` for the designed no-op — so a truthy object is what "it landed" looks like
// now, where `{ changes: 1 }` said it before.
vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: vi.fn(() => 'conv-stub'),
}));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertMessageIfAbsent: vi.fn(() => ({
    seq: 1, id: 'stub', lane: 'a2a', displayKind: 'a2a', displayTier: 'agent-only',
    tokenCount: 1, createdAt: '2026-07-28 00:00:00', sentAt: 1_800_000_000_000,
  })),
}));

const SENDER = 'primary';
const RECEIVER = 'worker';
const THREAD = 'thread-rc14';

function seedThread(opts: { lastSender: string; lastIntent: string; ageMinutes?: number }): void {
  const db = mockDb.current!;
  const when = opts.ageMinutes ? `datetime('now', '-${opts.ageMinutes} minutes')` : `datetime('now')`;
  db.prepare(
    `INSERT INTO a2a_threads (thread_id, hop_count, last_sender, last_intent, is_terminal, created_at, updated_at)
     VALUES (?, 1, ?, ?, 0, datetime('now'), ${when})`,
  ).run(THREAD, opts.lastSender, opts.lastIntent);
}

async function deliver(overrides: Partial<{ intent: string; fromAgent: string; requiresResponse: boolean; payload: string }>) {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  return deliverA2AMessage({
    intent: (overrides.intent ?? 'QUESTION') as never,
    threadId: THREAD,
    requiresResponse: overrides.requiresResponse ?? true,
    payload: overrides.payload ?? 'Any update on the vendor list yet?',
    toAgent: RECEIVER,
    fromAgent: overrides.fromAgent ?? SENDER,
  });
}

beforeEach(() => {
  handleMessage.mockClear();
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE a2a_threads (
      thread_id TEXT PRIMARY KEY,
      hop_count INTEGER DEFAULT 0,
      last_sender TEXT,
      last_intent TEXT,
      is_terminal INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    -- PHASE-1 T6: the fixture carries the SPINE columns, because the latch's
    -- carve-out read is one table scoped by lane now. A fixture without a lane
    -- column would let the carve-out silently stop being tested.
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      role TEXT,
      content TEXT,
      lane TEXT NOT NULL DEFAULT 'owner',
      channel TEXT,
      conv_key TEXT,
      inbound_meta TEXT,
      source_agent_id TEXT,
      a2a_thread_id TEXT,
      a2a_intent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- PHASE-2 T4: the transport reads the SPINE for a thread's hop count (DECIDED D2), so a
    -- fixture without the work table would make the hop gate throw instead of testing the latch. Only
    -- the columns the transport touches are declared; a hand-modelled schema that drifts from
    -- the real one is a fixture that passes while asserting nothing (T3's own finding).
    CREATE TABLE work (
      id TEXT PRIMARY KEY,
      kind TEXT,
      parent_id TEXT,
      agent_id TEXT,
      assignee_agent TEXT,
      root_kind TEXT,
      root_id TEXT,
      state TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      result_delivery_id TEXT,
      remaining_children INTEGER,
      compile_pending INTEGER NOT NULL DEFAULT 0,
      reply_conversation_id TEXT,
      ttl_at INTEGER,
      opened_at INTEGER,
      updated_at INTEGER
    );
  `);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'active')`).run(SENDER, 'Kevin');
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'active')`).run(RECEIVER, 'Maddy');
  mockDb.current = db;
});

describe('RC-14 awaiting-reply latch', () => {
  it('drops a wake-intent re-ask while the sender owes an unanswered reply, within cooldown', async () => {
    // Sender's last delivery on the thread was their own QUESTION, no reply yet.
    seedThread({ lastSender: SENDER, lastIntent: 'QUESTION' });
    const result = await deliver({ intent: 'QUESTION' });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('AWAITING_REPLY');
    expect(result.threadId).toBe(THREAD);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('latches ASSIGN and BLOCK the same way', async () => {
    seedThread({ lastSender: SENDER, lastIntent: 'ASSIGN' });
    const assignResult = await deliver({ intent: 'ASSIGN', payload: 'Please pull the Q3 numbers.' });
    expect(assignResult.reason).toBe('AWAITING_REPLY');

    // Fresh thread state for the BLOCK case.
    mockDb.current!.prepare('DELETE FROM a2a_threads').run();
    seedThread({ lastSender: SENDER, lastIntent: 'BLOCK' });
    const blockResult = await deliver({ intent: 'BLOCK', payload: 'Still blocked on the vendor list.' });
    expect(blockResult.reason).toBe('AWAITING_REPLY');
  });

  it('does NOT latch once the receiver has replied on the thread (carve-out)', async () => {
    seedThread({ lastSender: SENDER, lastIntent: 'QUESTION' });
    // Receiver posted a reply back to the sender on this thread: it lands in the
    // sender's inbox as an a2a-lane row (agent_id=sender, source_agent_id=receiver).
    mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, lane, source_agent_id, a2a_thread_id, a2a_intent, created_at)
       VALUES ('r1', ?, 'user', '[A2A:ANSWER] here you go', 'a2a', ?, ?, 'ANSWER', datetime('now'))`,
    ).run(SENDER, RECEIVER, THREAD);
    const result = await deliver({ intent: 'QUESTION' });
    expect(result.reason).not.toBe('AWAITING_REPLY');
    expect(result.delivered).toBe(true);
  });

  it('does NOT latch after the cooldown window has elapsed', async () => {
    seedThread({ lastSender: SENDER, lastIntent: 'QUESTION', ageMinutes: 20 });
    const result = await deliver({ intent: 'QUESTION' });
    expect(result.reason).not.toBe('AWAITING_REPLY');
    expect(result.delivered).toBe(true);
  });

  it('does NOT latch a system/engine envelope (carve-out)', async () => {
    seedThread({ lastSender: 'system', lastIntent: 'QUESTION' });
    const result = await deliver({ intent: 'QUESTION', fromAgent: 'system' });
    expect(result.reason).not.toBe('AWAITING_REPLY');
    expect(result.delivered).toBe(true);
  });

  it('does NOT latch a non-reopening intent (STATUS) even mid-cooldown', async () => {
    seedThread({ lastSender: SENDER, lastIntent: 'QUESTION' });
    const result = await deliver({ intent: 'STATUS', requiresResponse: false, payload: 'still digging, ~40% done' });
    expect(result.reason).not.toBe('AWAITING_REPLY');
    expect(result.delivered).toBe(true);
  });

  it('does NOT latch when the last thread delivery was the receiver, not this sender', async () => {
    // last_sender is the receiver: the sender does not currently owe a reply.
    seedThread({ lastSender: RECEIVER, lastIntent: 'QUESTION' });
    const result = await deliver({ intent: 'QUESTION' });
    expect(result.reason).not.toBe('AWAITING_REPLY');
    expect(result.delivered).toBe(true);
  });
});
