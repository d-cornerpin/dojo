// PHASE-1 T9 — the broadcast carries the PERSISTED ROW (research 17 §C4).
//
// The defect this closes, in one line: the dashboard learns about a message from a
// hand-built literal at ~70 broadcast sites, and NOTHING made that literal agree with the
// row that was stored. Research 17 measured the consequences as twelve divergence points;
// three of them are asserted here directly — D3 (streamed text != persisted text), D7 (two
// different `createdAt` formats, string-compared in the client), and the display columns
// having no reader at all.
//
// The fix is ONE seam, not ~70 edits. `gateway/ws.ts` already had a single stamp point
// (`deriveOrigin` for attribution) precisely because "there are ~70 broadcast sites and most
// build a partial Message literal". T9 widens that seam: every `chat:message` is looked up
// by its own id and stamped with what the database actually holds. A site that broadcasts
// without a row is then structurally visible, which is what BROADCAST_EQUALS_ROW enforces
// in the kit.
//
// These tests run against the REAL migration chain in an in-memory database, so the row the
// seam reads is a row migration 132 actually produced — display CHECK, epoch-ms time and all.

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

import { stampPersistedRow } from '../ws.js';
import { insertMessage } from '../../memory/message-store.js';
import { runMigrations } from '../../db/migrations.js';
import type { ChatMessageEvent, Message } from '@dojo/shared';

const AGENT = 'agent-broadcast-row';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current
    .prepare("INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')")
    .run(AGENT, 'Broadcast Test');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** The shape ~70 sites hand-build today: id + role + content + a fresh ISO timestamp. */
function literalEvent(id: string, role: Message['role'], content: string): ChatMessageEvent {
  return {
    type: 'chat:message',
    agentId: AGENT,
    message: {
      id,
      agentId: AGENT,
      role,
      content,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  };
}

describe('T9 — every chat:message carries the persisted row', () => {
  it('stamps seq, lane and the display columns from the row the writer actually wrote', () => {
    const p = insertMessage({ id: 'row-1', agentId: AGENT, role: 'assistant', content: 'Hello.' });
    const ev = literalEvent('row-1', 'assistant', 'Hello.');

    expect(stampPersistedRow(ev)).toBe('stamped');
    expect(ev.row).toBeDefined();
    expect(ev.row!.seq).toBe(p.seq);
    expect(ev.row!.id).toBe('row-1');
    expect(ev.row!.lane).toBe('owner');
    expect(ev.row!.displayKind).toBe('agent-text');
    expect(ev.row!.displayTier).toBe('user-visible');
  });

  it('carries ONE time: epoch-ms on the row, and the SAME instant in the text form the reload route serves (D7)', () => {
    insertMessage({ id: 'row-2', agentId: AGENT, role: 'assistant', content: 'Timed.' });
    const ev = literalEvent('row-2', 'assistant', 'Timed.');
    stampPersistedRow(ev);

    const stored = mockDb.current!
      .prepare("SELECT created_at, datetime(created_at/1000,'unixepoch') AS text FROM messages WHERE id = 'row-2'")
      .get() as { created_at: number; text: string };

    expect(typeof ev.row!.createdAt).toBe('number');
    expect(ev.row!.createdAt).toBe(stored.created_at);
    // The literal's `new Date().toISOString()` is REPLACED with the route's own projection,
    // so a client comparing live and reloaded rows compares like with like.
    expect(ev.message.createdAt).toBe(stored.text);
    expect(ev.message.createdAt).not.toContain('T');
  });

  it('broadcasts the STORED content, not the pre-strip in-memory string (D3 + the T8 mood gap)', () => {
    // T8 moved the orb mood marker out of `content` and into its own column at INSERT.
    // The engine still holds the raw string in memory, so a hand-built literal ships the
    // marker to the browser while the stored row is clean — the gap STATUS.md recorded at
    // the T8 boundary.
    insertMessage({ id: 'row-3', agentId: AGENT, role: 'assistant', content: '((mood: calm)) All set.' });
    const ev = literalEvent('row-3', 'assistant', '((mood: calm)) All set.');
    stampPersistedRow(ev);

    expect(ev.message.content).toBe('All set.');
    expect(ev.message.content).not.toContain('((mood:');
    expect(ev.row!.mood).toBe('calm');
  });

  it('reports an emission with NO row rather than shipping it as if it had one', () => {
    const ev = literalEvent('never-persisted', 'assistant', 'ghost');
    expect(stampPersistedRow(ev)).toBe('orphan');
    expect(ev.row).toBeUndefined();
  });

  it('still derives origin — the seam widened, it did not replace what was there', () => {
    insertMessage({ id: 'row-4', agentId: AGENT, role: 'user', content: 'Morning.' });
    const ev = literalEvent('row-4', 'user', 'Morning.');
    stampPersistedRow(ev);
    expect(ev.message.origin).toBeDefined();
  });

  it('leaves non-chat:message events alone', () => {
    const ev = { type: 'chat:chunk', agentId: AGENT, messageId: 'x', content: 'a', done: false } as const;
    expect(stampPersistedRow(ev)).toBe('not-chat-message');
  });

  it('carries the a2a lane honestly when one is looked up (the rekey has a fact to key on)', () => {
    insertMessage({ id: 'row-5', agentId: AGENT, role: 'assistant', lane: 'a2a', content: 'coordination' });
    const ev = literalEvent('row-5', 'assistant', 'coordination');
    stampPersistedRow(ev);
    expect(ev.row!.lane).toBe('a2a');
    expect(ev.row!.displayTier).toBe('agent-only');
  });
});
