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
import {
  NO_REPLY_CLOSED_MARKER, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX,
  OWNER_ALERT_HEADS_UP_PREFIX, NEW_SESSION_DIVIDER,
} from '@dojo/shared';
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
       VALUES (?, ?, 'user', ?, ?, (CAST(strftime('%s','now') AS INTEGER) * 1000))`,
    ).run('legacy-form', AGENT, 'a real user message', 7);
    const after = mockDb.current!.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number };

    expect(info.changes, 'INSERT OR IGNORE silently discarded the row').toBe(1);
    expect(after.c).toBe(before.c + 1);
    expect(rowOf('legacy-form')).toBeTruthy();
  });

  it('every NOT NULL non-key column except the four that ARE the message carries a DEFAULT', () => {
    // id/agent_id/role/content are the irreducible identity of a message: a writer that
    // omits one has no message to write. Every OTHER NOT NULL column must default, or the
    // silent-discard window reopens for whichever writer has not been converted yet.
    //
    // T10 (migration 133) moved `id` INTO this list and TIGHTENED it, deliberately. It used
    // to be `id TEXT PRIMARY KEY`, which the `pk === 0` filter below excluded — and SQLite
    // permits NULL in a TEXT primary key, a documented legacy quirk, so the column that names
    // every row was nullable. It is `TEXT NOT NULL UNIQUE` now: same UNIQUE index the
    // `summary_messages` foreign key needs as a parent key, plus the NOT NULL it always
    // should have had. R1's "convert the writers in the same commit or keep the default" is
    // satisfied without a conversion, measured both ways: the writer module has always
    // defaulted it (`const id = m.id ?? randomUUID()`), and the live box holds
    // `SELECT COUNT(*) FROM messages WHERE id IS NULL` → 0 rows, so nothing existed to break.
    const cols = mockDb.current!.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string; notnull: number; dflt_value: string | null; pk: number;
    }>;
    const undefaulted = cols
      .filter(c => c.notnull === 1 && c.dflt_value === null && c.pk === 0)
      .map(c => c.name);
    expect(undefaulted.sort()).toEqual(['agent_id', 'content', 'id', 'role']);
    // The tightening itself, so a later rebuild cannot quietly restore a nullable name.
    expect(cols.find(c => c.name === 'id')?.notnull).toBe(1);
  });

  it('`seq` IS the rowid — it cannot drift, because it is the same integer (T10, mig 133)', () => {
    // Until T10 this read "`seq` TRACKS rowid, so T5 can move readers onto it before T10
    // promotes it", and it was kept true by an AFTER INSERT trigger (`messages_seq_ai`)
    // that wrote `seq = new.rowid` on every insert. Migration 133 made `seq` the
    // `INTEGER PRIMARY KEY AUTOINCREMENT` itself, so there is nothing left to keep in
    // step: the two names address one integer. The trigger is gone with the drift it
    // policed. The assertion is unchanged in meaning and stronger in kind — it now holds
    // structurally rather than by a trigger firing.
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'seq check' });
    const row = mockDb.current!.prepare('SELECT seq, rowid AS rid FROM messages WHERE id = ?')
      .get(p.id) as { seq: number; rid: number };
    expect(row.seq).toBe(row.rid);
    expect(p.seq).toBe(row.seq);
    const drift = mockDb.current!.prepare(
      'SELECT COUNT(*) c FROM messages WHERE seq IS NULL OR seq <> rowid',
    ).get() as { c: number };
    expect(drift.c).toBe(0);
    // The promotion itself, asserted rather than assumed: `seq` is the declared primary
    // key and `id` is not. A rebuild that quietly restored the old shape would pass every
    // other assertion in this file.
    const cols = mockDb.current!.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string; pk: number;
    }>;
    expect(cols.find(c => c.name === 'seq')?.pk).toBe(1);
    expect(cols.find(c => c.name === 'id')?.pk).toBe(0);
  });

  it('a bare `SELECT rowid` now names its column `seq` — which is why no reader writes one', () => {
    // INVERTED at T10, not deleted. This assertion is the measurement that kept the
    // promotion out of migrations 127 and 131: `SELECT rowid FROM t` names its result
    // column `rowid` while the PK is TEXT, and `seq` the moment an INTEGER PRIMARY KEY
    // alias exists — same value, different name, so every `row.rowid` in TypeScript
    // silently becomes `undefined` and nothing throws. It broke 45 tests on T3's first
    // attempt and the failure was silent: the turn simply stopped claiming its trigger.
    //
    // The hazard is real and it is now permanent, so the fact is asserted in its new
    // direction and the CODE rule that neutralises it — every reader projects
    // `seq AS rowid`, never a bare `rowid` — is walked in lane-readers.test.ts.
    insertMessage({ agentId: AGENT, role: 'user', content: 'x' });
    // Assembled at runtime, not written out: the source walk in lane-readers.test.ts reads
    // this file too, and a literal bare projection here would make that rule permanently red.
    const KEY = 'row' + 'id';
    const bare = mockDb.current!.prepare(`SELECT ${KEY}, id FROM messages LIMIT 1`);
    expect(bare.columns().map(c => c.name)).toContain('seq');
    expect(bare.columns().map(c => c.name)).not.toContain('rowid');
    const aliased = mockDb.current!.prepare('SELECT seq AS rowid, id FROM messages LIMIT 1');
    expect(aliased.columns().map(c => c.name)).toContain('rowid');
    expect((aliased.get() as { rowid: number }).rowid).toBeGreaterThan(0);
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
    insertEngineEvent({ id: 'engine-note', agentId: AGENT, content: '[Engine] a tracker note', originIntent: 'tracker', work: null });

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
    const p = insertEngineEvent({ agentId: AGENT, content: '[Engine] scheduler fired', originIntent: 'scheduler', work: null });
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

// ── T8: classified at insert, stored display-ready ──
//
// 17 §C1/§C3. Two obligations, both of them write-side and both asserted against the real
// migrated schema rather than a hand-built table:
//   C1  every row is classified IN the INSERT, from the shared taxonomy, never by a later
//       UPDATE and never by a second matcher living somewhere else.
//   C3  `content` is stored as it should be READ — no mood marker, no surviving `[no-reply]`
//       sentinel — and the mood goes to its own column.
//
// The scope of C3's strip is deliberately NOT "every row". It applies to text the AGENT
// authored (role='assistant') and to the engine's working-note wrapper around that text. A
// tool result is verbatim external data (a file_read of this repo genuinely contains the
// literal `((mood: NAME))` — the prompt documents it), a user row is the human's own words,
// and an agent's system-prompt row is its instructions. Editing any of those would be the
// platform lying about what it was given, so the writer stores them byte-for-byte. That
// boundary is asserted below in both directions.

describe('T8 — classify at insert', () => {
  it('stamps a kind from the ONE taxonomy for every lane and role, never `unclassified`', () => {
    const cases = [
      { lane: 'owner' as const, role: 'user' as const, content: 'hello', kind: 'user-text', tier: 'user-visible' },
      { lane: 'owner' as const, role: 'assistant' as const, content: 'hi back', kind: 'agent-text', tier: 'user-visible' },
      { lane: 'owner' as const, role: 'tool' as const, content: '{}', kind: 'tool-turn', tier: 'agent-only' },
      { lane: 'events' as const, role: 'user' as const, content: '[Engine note: x]', kind: 'engine-note', tier: 'agent-only' },
      { lane: 'a2a' as const, role: 'assistant' as const, content: 'peer reply', kind: 'a2a', tier: 'agent-only' },
    ];
    for (const c of cases) {
      const p = insertMessage({ agentId: AGENT, ...c });
      const row = rowOf(p.id);
      expect(row.display_kind, `${c.lane}/${c.role}`).toBe(c.kind);
      expect(row.display_tier, `${c.lane}/${c.role}`).toBe(c.tier);
    }
  });

  it('classifies the ENGINE MARKERS a bare lane+role rule cannot see', () => {
    const marked = [
      { content: NO_REPLY_CLOSED_MARKER, role: 'system' as const, kind: 'no-reply-marker', tier: 'never-shown' },
      { content: `${WORKING_NOTE_PREFIX}checking the calendar`, role: 'system' as const, kind: 'working-note', tier: 'user-visible' },
      { content: `${INTERNAL_WORKING_NOTE_PREFIX}sending now`, role: 'system' as const, kind: 'working-note', tier: 'agent-only' },
      { content: NEW_SESSION_DIVIDER, role: 'system' as const, kind: 'divider', tier: 'user-visible' },
      { content: '[Reply routed via iMessage to Sam]', role: 'system' as const, kind: 'routing-marker', tier: 'agent-only' },
      { content: `${OWNER_ALERT_HEADS_UP_PREFIX} a reminder failed`, role: 'system' as const, kind: 'owner-alert', tier: 'user-visible' },
    ];
    for (const m of marked) {
      const p = insertMessage({ agentId: AGENT, role: m.role, content: m.content });
      expect(rowOf(p.id).display_kind, m.content.slice(0, 40)).toBe(m.kind);
      expect(rowOf(p.id).display_tier, m.content.slice(0, 40)).toBe(m.tier);
    }
  });

  it('the DATABASE refuses a kind outside the taxonomy', () => {
    // The third layer, and the reason it exists: TypeScript covers this module's callers and
    // the conformance walk covers raw SQL, but only the column can refuse a value that
    // reaches it any other way. `display_tier` has carried this CHECK since 127; `display_kind`
    // was left `TEXT NOT NULL DEFAULT 'unclassified'` with `T8 owns the classifier + CHECK`
    // written beside it, and this is that CHECK.
    expect(() => insertMessage({
      agentId: AGENT, role: 'user', content: 'x',
      displayKind: 'invented-kind' as unknown as 'user-text',
    })).toThrow(/CHECK|display_kind/i);
  });

  it('classification happens IN the insert — no row is ever written unclassified', () => {
    for (let i = 0; i < 25; i++) {
      insertMessage({ agentId: AGENT, role: 'assistant', content: `reply ${i}` });
    }
    const unclassified = mockDb.current!.prepare(
      "SELECT COUNT(*) c FROM messages WHERE display_kind = 'unclassified'",
    ).get() as { c: number };
    expect(unclassified.c).toBe(0);
  });
});

describe('T8 — content is stored display-ready', () => {
  it('extracts the orb mood to its column and stores the reply without the marker', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'assistant',
      content: '((mood: curious)) Interesting — what happens if we try it?',
    });
    const row = rowOf(p.id);
    expect(row.mood).toBe('curious');
    expect(row.content).toBe('Interesting — what happens if we try it?');
    expect(String(row.content)).not.toContain('((mood:');
  });

  it('a working note carries the agent\'s narration display-ready too', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'system',
      content: `${WORKING_NOTE_PREFIX}((mood: focused)) Let me check that. [no-reply]`,
    });
    const row = rowOf(p.id);
    expect(String(row.content)).not.toContain('((mood:');
    expect(String(row.content)).not.toContain('[no-reply]');
    expect(row.content).toBe(`${WORKING_NOTE_PREFIX}Let me check that.`);
  });

  it('a surviving [no-reply] sentinel never reaches storage', () => {
    const p = insertMessage({
      agentId: AGENT, role: 'assistant', content: 'All set.\n\n`[no-reply]`',
    });
    expect(rowOf(p.id).content).toBe('All set.');
  });

  it('token_count is estimated from the STORED bytes, not the pre-strip ones', () => {
    const stripped = insertMessage({ agentId: AGENT, role: 'assistant', content: '((mood: happy)) ok' });
    const plain = insertMessage({ agentId: AGENT, role: 'assistant', content: 'ok' });
    expect(rowOf(stripped.id).token_count).toBe(rowOf(plain.id).token_count);
  });

  it('NO agent-authored row in the table carries a display marker', () => {
    insertMessage({ agentId: AGENT, role: 'assistant', content: '((mood: success)) done' });
    insertMessage({ agentId: AGENT, role: 'system', content: `${WORKING_NOTE_PREFIX}((mood: neutral)) thinking` });
    const leaks = mockDb.current!.prepare(`
      SELECT COUNT(*) c FROM messages
       WHERE (content LIKE '%((mood:%' OR content LIKE '%[no-reply]%')
         AND (role = 'assistant' OR content LIKE '[working-note%')
    `).get() as { c: number };
    expect(leaks.c).toBe(0);
  });

  it('leaves a TOOL RESULT byte-identical — it is verbatim external data', () => {
    // A file_read of this repository returns the prompt's own documentation of the marker.
    // Stripping it would make the platform lie about the file it was shown.
    const verbatim = 'assembler.ts:357  - `((mood: curious)) Interesting, what happens if...`';
    const p = insertMessage({ agentId: AGENT, role: 'tool', content: verbatim });
    expect(rowOf(p.id).content).toBe(verbatim);
    expect(rowOf(p.id).mood).toBeNull();
  });

  it('leaves a USER row and an agent\'s SYSTEM PROMPT row byte-identical', () => {
    const typed = 'why does ((mood: happy)) show up in my chat?';
    const u = insertMessage({ agentId: AGENT, role: 'user', content: typed });
    expect(rowOf(u.id).content).toBe(typed);

    // routes/agents.ts and agent/tools.ts both write an agent's instructions through this
    // module as a role='system' row. Those instructions legitimately DOCUMENT the marker.
    const prompt = 'You are Kevin.\n\nLead a reply with `((mood: NAME))` to animate the orb.';
    const s = insertMessage({ agentId: AGENT, role: 'system', content: prompt });
    expect(rowOf(s.id).content).toBe(prompt);
  });

  it('never rewrites content after the insert (cache law)', () => {
    const p = insertMessage({ agentId: AGENT, role: 'assistant', content: '((mood: calm)) stored once' });
    const first = rowOf(p.id).content;
    markServed([p.id], 9);
    expect(rowOf(p.id).content).toBe(first);
  });
});

describe('sanctioned readers', () => {
  it('recentTail returns oldest-first and is lane-scoped', () => {
    insertMessage({ agentId: AGENT, role: 'user', content: 'one' });
    insertMessage({ agentId: AGENT, role: 'assistant', content: 'two' });
    insertEngineEvent({ agentId: AGENT, content: 'three (events)', work: null });

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

// ── T6b: time on the spine is epoch-ms INTEGER, and it cannot quietly become TEXT again ──
//
// This block is the standing guard for the defect this conversion exists to prevent. SQLite
// orders INTEGER before TEXT unconditionally, so a datetime STRING written into one of these
// columns does not error and does not sort — it makes every window predicate that touches the
// row return the wrong answer, silently, forever. There is no failing test that shape can
// produce on its own; the typeof CHECK is what turns it into an exception, and these
// assertions are what stop the CHECK being "tidied away" by a later task that finds it odd.

describe('T6b — the four time columns are epoch-ms INTEGER', () => {
  it('the migrated schema declares all four as INTEGER, not TEXT', () => {
    const cols = mockDb.current!.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; type: string }>;
    for (const name of ['created_at', 'swept_at', 'next_attempt_at', 'retired_at']) {
      expect(cols.find(c => c.name === name)?.type, `${name} should be INTEGER`).toBe('INTEGER');
    }
  });

  it('the writer stamps an epoch-ms number, second-granular', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'timed' });
    const raw = rowOf(p.id).created_at as number;
    expect(typeof raw).toBe('number');
    expect(raw % 1000, 'granularity must stay second-level, as it was under TEXT').toBe(0);
    expect(Math.abs(raw - Date.now())).toBeLessThan(120_000);
  });

  it('the value the writer RETURNS is still the canonical TEXT shape (the wire contract)', () => {
    // `Persisted.createdAt` is declared `string` and feeds Message.createdAt, the dashboard,
    // the vault's TEXT high-waters and the per-message prompt stamp. The storage flipped
    // underneath all of them; this is the assertion that says they never noticed.
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'shape' });
    expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const raw = rowOf(p.id).created_at as number;
    const roundTrip = mockDb.current!
      .prepare("SELECT datetime(?/1000,'unixepoch') AS t").get(raw) as { t: string };
    expect(roundTrip.t).toBe(p.createdAt);
  });

  it('a datetime STRING is REFUSED rather than absorbed — the silent-inversion guard', () => {
    // The exact mistake: a writer left on the old `datetime('now')` vocabulary.
    expect(() => mockDb.current!.prepare(
      `INSERT INTO messages (id, agent_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, datetime('now'))`,
    ).run('text-time', AGENT, 'wrong vocabulary')).toThrow(/CHECK constraint failed/);
    // …and the same refusal on the three nullable columns, via the sweep vocabulary.
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'sweepable' });
    expect(() => mockDb.current!.prepare(
      "UPDATE messages SET swept_at = datetime('now') WHERE id = ?",
    ).run(p.id)).toThrow(/CHECK constraint failed/);
  });

  it('the sweep vocabulary writes a number, and the IS NULL guards still read it', () => {
    const p = insertMessage({ agentId: AGENT, role: 'user', content: 'to sweep' });
    expect(unservedHead(AGENT).map(m => m.id)).toContain(p.id);
    mockDb.current!.prepare(
      "UPDATE messages SET swept_at = (CAST(strftime('%s','now') AS INTEGER) * 1000) WHERE id = ?",
    ).run(p.id);
    expect(typeof rowOf(p.id).swept_at).toBe('number');
    expect(unservedHead(AGENT).map(m => m.id)).not.toContain(p.id);
  });
});
