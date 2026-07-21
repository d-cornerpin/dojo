// P5 conversations: identity resolution unit contract.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { resolveOrCreateConversation, dominantMessageLineage } from '../conversations.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      provider TEXT,
      counterparty_id TEXT,
      counterparty_name TEXT,
      thread_root TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT,
      UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      conv_key TEXT,
      a2a_thread_id TEXT
    );
    CREATE TABLE inter_agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      conv_key TEXT,
      a2a_thread_id TEXT
    );
  `);
  mockDb.current = db;
});

describe('resolveOrCreateConversation (P5)', () => {
  it('same identity resolves to the same conversation', () => {
    const a = resolveOrCreateConversation('agent-1', { channel: 'imessage', provider: 'imessage', counterpartyId: '+15550001111' });
    const b = resolveOrCreateConversation('agent-1', { channel: 'imessage', provider: 'imessage', counterpartyId: '+15550001111' });
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it('the email collapse is fixed: same sender, different threads = different conversations; same thread = same', () => {
    const t1 = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'pat@example.com', threadRoot: 'thread-A' });
    const t2 = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'pat@example.com', threadRoot: 'thread-B' });
    const t1again = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'pat@example.com', threadRoot: 'thread-A' });
    expect(t1).not.toBe(t2);
    expect(t1again).toBe(t1);
  });

  it('providers do not collapse: gmail vs outlook same sender = different conversations', () => {
    const g = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'pat@example.com', threadRoot: 'x' });
    const o = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'outlook', counterpartyId: 'pat@example.com', threadRoot: 'x' });
    expect(g).not.toBe(o);
  });

  it('counterparty ids are case-normalized (one human, one row)', () => {
    const a = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'Pat@Example.com', threadRoot: 't' });
    const b = resolveOrCreateConversation('agent-1', { channel: 'email', provider: 'gmail', counterpartyId: 'pat@example.com', threadRoot: 't' });
    expect(b).toBe(a);
  });
});


// P5c: summaries/archives carry the dominant lineage of their chunk.
describe('dominantMessageLineage (P5c)', () => {
  it('returns the modal non-null lineage across both message stores', () => {
    const db = mockDb.current!;
    const ins = db.prepare('INSERT INTO messages (id, conversation_id, conv_key, a2a_thread_id) VALUES (?, ?, ?, ?)');
    ins.run('m1', 'convA', 'imessage:x', null);
    ins.run('m2', 'convA', 'imessage:x', null);
    ins.run('m3', 'convB', 'dashboard', null);
    ins.run('m4', null, null, null);
    db.prepare('INSERT INTO inter_agent_messages (id, conversation_id, conv_key, a2a_thread_id) VALUES (?, ?, ?, ?)')
      .run('ia1', 'convA', 'a2a:t', 'thread-9');
    const l = dominantMessageLineage(['m1', 'm2', 'm3', 'm4', 'ia1']);
    expect(l.conversationId).toBe('convA');
    expect(l.convKey).toBe('imessage:x');
    expect(l.a2aThreadId).toBe('thread-9');
  });

  it('is all-null on empty input and unknown ids, and never throws without a DB', () => {
    expect(dominantMessageLineage([])).toEqual({ conversationId: null, convKey: null, a2aThreadId: null });
    expect(dominantMessageLineage(['nope'])).toEqual({ conversationId: null, convKey: null, a2aThreadId: null });
    mockDb.current = null;
    expect(dominantMessageLineage(['m1'])).toEqual({ conversationId: null, convKey: null, a2aThreadId: null });
  });

  it('breaks ties deterministically (lexicographic smallest wins at equal count)', () => {
    const db = mockDb.current!;
    const ins = db.prepare('INSERT INTO messages (id, conversation_id, conv_key, a2a_thread_id) VALUES (?, ?, ?, ?)');
    ins.run('t1', 'convZ', null, null);
    ins.run('t2', 'convA', null, null);
    expect(dominantMessageLineage(['t1', 't2']).conversationId).toBe('convA');
  });
});
