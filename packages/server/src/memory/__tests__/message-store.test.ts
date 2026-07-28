// PHASE-1 T3 Step 3 — the single writer module, and the constraints it exists to enforce.
//
// Everything here runs against the REAL migration chain in an in-memory database, so the
// assertions are made against migration 127's actual output rather than a hand-built table.
// That matters more than usual for this task: the whole point of 127 is what the DATABASE
// refuses, and a hand-rolled fixture would let a wrong CHECK pass unnoticed.
//
// The `R1` block is the regression guard for the defect that blocked this task's first
// attempt. `INSERT OR IGNORE` applies SQLite's IGNORE conflict resolution to NOT NULL and
// CHECK violations, not only UNIQUE — so a spine column without a DEFAULT turns 80 of the
// platform's 87 message writers into silent no-ops: run() returns {changes:0}, nothing is
// thrown, nothing is logged, and the message is gone. Measured on a VACUUM INTO copy before
// this shape was chosen. R1 (PHASE-1.md, T3 resolution block) forbids that state at EVERY
// commit boundary, and these tests are how it stays forbidden while T4 converts the writers.

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

import {
  insertMessage, insertEngineEvent, claimForTurn, markServed,
  recentTail, byIds, unservedHead,
} from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-msgstore';
const PEER = 'agent-peer';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const ins = mockDb.current.prepare(
    "INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')",
  );
  ins.run(AGENT, 'Store Test');
  ins.run(PEER, 'Peer');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const rowOf = (id: string) =>
  mockDb.current!.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown>;

// ── R1: the silent-discard class stays closed ──

describe('R1 — no writer may lose a row silently', () => {
  it('the legacy INSERT OR IGNORE form that 80 of 87 writers use still PERSISTS', () => {
    const before = mockDb.current!.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number };
    const info = mockDb.current!.prepare(
      `INSERT OR IGNORE INTO messages (id, agent_id, role, content, turn_number, created_at)
       VALUES (?, ?, 'user', ?, ?, datetime('now'))`,
    ).run('legacy-form', AGENT, 'a real user message', 7);
    const after = mockDb.current!.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number };

    expect(info.changes, 'INSERT OR IGNORE silently discarded the row').toBe(1);
    expect(after.c).toBe(before.c + 1);
    expect(rowOf('legacy-form')).toBeTruthy();
  });

  it('every NOT NULL non-key column except the three that ARE the message carries a DEFAULT', () => {
    // agent_id/role/content (plus `id`, which is the primary key and so excluded by the
    // pk filter) are the irreducible identity of a message: a writer that omits one has no
    // message to write. Every OTHER NOT NULL column must default, or the silent-discard
    // window reopens for whichever writer has not been converted yet.
    const cols = mockDb.current!.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string; notnull: number; dflt_value: string | null; pk: number;
    }>;
    const undefaulted = cols
      .filter(c => c.notnull === 1 && c.dflt_value === null && c.pk === 0)
      .map(c => c.name);
    expect(undefaulted.sort()).toEqual(['agent_id', 'content', 'role']);
  });

  it('`seq` tracks rowid exactly, so T5 can move readers onto it before T10 promotes it', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'seq check' });
    const row = mockDb.current!.prepare('SELECT seq, rowid FROM messages WHERE id = ?')
      .get(p.id) as { seq: number; rowid: number };
    expect(row.seq).toBe(row.rowid);
    expect(p.seq).toBe(row.seq);
    const drift = mockDb.current!.prepare(
      'SELECT COUNT(*) c FROM messages WHERE seq IS NULL OR seq <> rowid',
    ).get() as { c: number };
    expect(drift.c).toBe(0);
  });

  it('a bare `SELECT rowid` still names its column `rowid` — 52 TS reads depend on it', () => {
    // The measured reason `seq` is not the INTEGER PRIMARY KEY yet. Promoting it renames
    // this result column to `seq`, every `row.rowid` becomes undefined, and nothing throws.
    insertMessage({ agentId: AGENT, role: 'user', content: 'x' });
    const stmt = mockDb.current!.prepare('SELECT rowid, id FROM messages LIMIT 1');
    expect(stmt.columns().map(c => c.name)).toContain('rowid');
  });

  it('engine traffic stays OUT of the human-facing view — now by the writer, not a trigger', () => {
    // PHASE-1 T4 (2026-07-27). This assertion used to drive a LEGACY raw INSERT and check
    // that the compat trigger reclassified it. Migration 128 dropped that trigger, because
    // its only job was classifying rows unconverted writers inserted and the conformance
    // allowlist is now at zero — there are none. Proven on a VACUUM INTO copy before the
    // drop: the writer module's rows are byte-identical with the trigger and without it,
    // on all three lanes.
    //
    // The REQUIREMENT is untouched and is what is asserted here: an engine row must never
    // be visible through `chat_messages`. It is now carried by the two things that will
    // still be standing at T10 — the writer stamping `lane` at ingest, and the fail-closed
    // view. Keeping the old form would have tested a mechanism that no longer exists.
    insertEngineEvent({ id: 'engine-note', agentId: AGENT, content: '[Engine] a tracker note', originIntent: 'tracker' });

    expect(rowOf('engine-note').lane).toBe('events');
    const visible = mockDb.current!.prepare(
      "SELECT COUNT(*) c FROM chat_messages WHERE id = 'engine-note'",
    ).get() as { c: number };
    expect(visible.c, 'engine traffic leaked into chat_messages').toBe(0);

    // And the same for peer traffic, which the same trigger used to cover.
    insertMessage({ id: 'peer-in', agentId: AGENT, role: 'user', lane: 'a2a', content: 'hi', sourceAgentId: 'peer-1' });
    expect(rowOf('peer-in').lane).toBe('a2a');
    expect((mockDb.current!.prepare("SELECT COUNT(*) c FROM chat_messages WHERE id = 'peer-in'")
      .get() as { c: number }).c, 'peer traffic leaked into chat_messages').toBe(0);
  });
});

// ── The writer module's own contract ──

describe('insertMessage', () => {
  it('stamps lane, display columns, token_count and both timestamps', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'hello there' });
    const row = rowOf(p.id);
    expect(row.lane).toBe('owner');
    expect(row.display_kind).toBe('user-text');
    expect(row.display_tier).toBe('user-visible');
    expect(row.token_count as number).toBeGreaterThan(0);
    expect(row.created_at).toBeTruthy();
    expect(row.sent_at as number).toBeGreaterThan(1600000000000);
    expect(row.provenance).toBe('live');
  });

  it('display columns are ALWAYS populated, for every lane and role', () => {
    const cases = [
      { lane: 'owner' as const, role: 'user' as const },
      { lane: 'owner' as const, role: 'assistant' as const },
      { lane: 'events' as const, role: 'system' as const },
      { lane: 'a2a' as const, role: 'assistant' as const },
      { lane: 'owner' as const, role: 'tool' as const },
    ];
    for (const c of cases) {
      const p = insertMessage({ agentId: AGENT, content: 'x', ...c });
      const row = rowOf(p.id);
      expect(row.display_kind, `${c.lane}/${c.role} display_kind`).toBeTruthy();
      expect(row.display_kind).not.toBe('unclassified');
      expect(['user-visible', 'agent-only', 'never-shown']).toContain(row.display_tier);
    }
  });

  it('token_count is estimated at write and is always > 0, even for empty-ish content', () => {
    expect(rowOf(insertMessage({ agentId: AGENT, role: 'user', content: '.' }).id).token_count as number)
      .toBeGreaterThan(0);
    const long = insertMessage({ agentId: AGENT, role: 'user', content: 'word '.repeat(500) });
    expect(rowOf(long.id).token_count as number).toBeGreaterThan(100);
  });

  it('REFUSES a lane outside the CHECK', () => {
    expect(() => insertMessage({
      agentId: AGENT, role: 'user', content: 'x',
      lane: 'nonsense' as unknown as 'owner',
    })).toThrow();
  });

  it('REFUSES an inbound a2a row that does not name its sender', () => {
    expect(() => insertMessage({
      agentId: AGENT, role: 'user', content: 'peer says hi', lane: 'a2a',
    })).toThrow(/source_agent_id|CHECK/i);
  });

  it('ACCEPTS the agent\'s OWN a2a output, which has no sender by design', () => {
    // memory/interagent.ts:145-147 — direction is carried by `role`, not by a column.
    // The unamended DDL rejected these; T3-0b caught it, and this is the guard.
    const p = insertMessage({ agentId: AGENT, role: 'assistant', content: 'my reply', lane: 'a2a' });
    expect(rowOf(p.id).lane).toBe('a2a');
    expect(rowOf(p.id).source_agent_id).toBeNull();
  });

  it('an inbound a2a row WITH a sender is accepted and stays out of the human view', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'user', content: 'peer question', lane: 'a2a', sourceAgentId: PEER,
    });
    expect(rowOf(p.id).source_agent_id).toBe(PEER);
    const visible = mockDb.current!.prepare('SELECT COUNT(*) c FROM chat_messages WHERE id = ?')
      .get(p.id) as { c: number };
    expect(visible.c).toBe(0);
  });

  it('rejects a duplicate id rather than silently ignoring it', () => {
    insertMessage({ agentId: AGENT, role: 'user', content: 'first', id: 'dup' });
    expect(() => insertMessage({ agentId: AGENT, role: 'user', content: 'second', id: 'dup' }))
      .toThrow();
  });

  it('stamps channel and authorized at ingest (OR4) without re-deriving them', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'user', content: 'sms in', channel: 'sms',
      senderId: '+15550100', authorized: false,
    });
    expect(rowOf(p.id).channel).toBe('sms');
    expect(rowOf(p.id).authorized).toBe(0);
    expect(rowOf(p.id).sender_id).toBe('+15550100');
  });
});

describe('insertEngineEvent', () => {
  it('always lands in the events lane and never in the human-facing view', () => {
    const p = insertEngineEvent({ agentId: AGENT, content: '[Engine] scheduler fired', originIntent: 'scheduler' });
    const row = rowOf(p.id);
    expect(row.lane).toBe('events');
    expect(row.origin_intent).toBe('scheduler');
    expect(row.display_tier).toBe('agent-only');
    const visible = mockDb.current!.prepare('SELECT COUNT(*) c FROM chat_messages WHERE id = ?')
      .get(p.id) as { c: number };
    expect(visible.c).toBe(0);
  });

  it('carries origin_intent on the OWNER lane too — Phase 4 (OR2) owns removing that, not Phase 1', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'assistant', content: 'on it', originIntent: 'engine_start_ack',
    });
    expect(rowOf(p.id).origin_intent).toBe('engine_start_ack');
    expect(rowOf(p.id).lane).toBe('owner');
  });
});

describe('sanctioned readers', () => {
  it('recentTail returns oldest-first and is lane-scoped', () => {
    insertMessage({ agentId: AGENT, role: 'user', content: 'one' });
    insertMessage({ agentId: AGENT, role: 'assistant', content: 'two' });
    insertEngineEvent({ agentId: AGENT, content: 'three (events)' });

    const all = recentTail(AGENT, { limit: 10 });
    expect(all.map(m => m.content)).toEqual(['one', 'two', 'three (events)']);

    const ownerOnly = recentTail(AGENT, { limit: 10, lanes: ['owner'] });
    expect(ownerOnly.map(m => m.content)).toEqual(['one', 'two']);
  });

  it('recentTail takes the NEWEST n and still returns them oldest-first', () => {
    for (let i = 0; i < 5; i++) insertMessage({ agentId: AGENT, role: 'user', content: `m${i}` });
    expect(recentTail(AGENT, { limit: 2 }).map(m => m.content)).toEqual(['m3', 'm4']);
  });

  it('byIds returns the requested rows and tolerates unknown ids', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', content: 'a' });
    const b = insertMessage({ agentId: AGENT, role: 'user', content: 'b' });
    const got = byIds([a.id, 'no-such-id', b.id]);
    expect(got.map(m => m.content).sort()).toEqual(['a', 'b']);
    expect(byIds([])).toEqual([]);
  });

  it('unservedHead returns only rows no turn has claimed, oldest first', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', content: 'first' });
    const b = insertMessage({ agentId: AGENT, role: 'user', content: 'second' });
    expect(unservedHead(AGENT).map(m => m.id)).toEqual([a.id, b.id]);

    markServed([a.id], 4);
    expect(unservedHead(AGENT).map(m => m.id)).toEqual([b.id]);
  });
});

describe('claimForTurn / markServed', () => {
  it('claimForTurn stamps the turn on unserved rows and returns what it claimed', () => {
    const a = insertMessage({ agentId: AGENT, role: 'user', content: 'a' });
    const b = insertMessage({ agentId: AGENT, role: 'user', content: 'b' });

    const claimed = claimForTurn(AGENT, 11);
    expect(claimed.map(m => m.id)).toEqual([a.id, b.id]);
    expect(rowOf(a.id).served_by_turn).toBe(11);
    expect(rowOf(b.id).turn_number).toBe(11);
  });

  it('a second claim finds nothing — a row is claimed once, never twice', () => {
    insertMessage({ agentId: AGENT, role: 'user', content: 'only' });
    expect(claimForTurn(AGENT, 1)).toHaveLength(1);
    expect(claimForTurn(AGENT, 2)).toEqual([]);
  });

  it('markServed never rewrites content — the cache law, asserted', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'original bytes' });
    markServed([p.id], 9);
    expect(rowOf(p.id).content).toBe('original bytes');
    expect(rowOf(p.id).served_by_turn).toBe(9);
  });

  it('markServed on an empty list is a no-op, not a full-table update', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'untouched' });
    markServed([], 3);
    expect(rowOf(p.id).served_by_turn).toBeNull();
  });
});
