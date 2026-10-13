// ════════════════════════════════════════════════════════════════════════════════════════
// t141 — MIGRATION 188 LABELS THE LEGACY ROWS ONCE, AND MOVES NO ROW IN OR OUT OF VIEW.
//
// Rehearsed per G13 against an ADVERSARIAL body: every shape of own row the old late stamp
// could leave behind (turnless, orphan turn, NULL turn number, a person's turn the stamp
// missed with and without a reconstructable conversation, agent-thread rows with the thread
// on the turn record / on the served peer row / nowhere, engine and background wakes), next to
// rows that must NOT be touched (already-stamped person replies, inbound, system, a row whose
// thread id is already set). Each statement of the file is run ONE AT A TIME with its own
// `changes` counted, and every branch must touch at least one row — a zero means the branch
// was never exercised, which is what G13 forbids believing.
//
// The membership clause is the owner's rule as a test: the set of own rows the owner's
// conversation keeps is computed with the PRE-188 rule (`!conversation_id || = this one`) on
// the body before the migration, and with the live scoper on the body after it. Equal, or red.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 't141-mig188', 'dojo.db'),
    closeDb: () => { /* not exercised */ },
  };
});

import { runMigrations } from '../migrations.js';
import { scopeToHumanConversation } from '../../memory/assembler.js';
import { getRecentMessages } from '../../memory/store.js';
import { subjectKindsBySeq } from '../../memory/message-store.js';
import type { TurnCounterparty } from '../../agent/v2/counterparty.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', 'migrations', '188_label_legacy_own_rows.sql');
const A = 'agent-188';
const OWNER_CONV = 'conv-owner-188';
const OTHER_CONV = 'conv-contact-188';
const MAIL_CONV = 'conv-mail-188';

let image: Buffer | null = null;
function migrated(): Database.Database {
  if (!image) {
    const s = new Database(':memory:');
    mockDb.current = s;
    runMigrations();
    image = s.serialize();
    s.close();
  }
  return new Database(image);
}

/** The file's statements, in order, comments stripped. Statement 0 is the ALTER. */
function statements(): string[] {
  const sql = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  return sql.split(';').map((s) => s.trim()).filter(Boolean);
}

let seq = 0;
function row(db: Database.Database, p: {
  id: string; role: string; lane?: string; turn?: number | null; conv?: string | null; thread?: string | null;
  servedBy?: number | null; channel?: string | null; sourceAgent?: string | null; content?: string;
}): void {
  seq += 1;
  db.prepare(`INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier, turn_number,
                conversation_id, a2a_thread_id, served_by_turn, channel, source_agent_id, provenance, authorized,
                token_count, created_at, sent_at)
              VALUES (?, ?, ?, ?, ?, 'agent-text', 'agent-only', ?, ?, ?, ?, ?, ?, 'live', 1, 5, ?, ?)`)
    .run(p.id, A, p.role, p.lane ?? 'owner', p.content ?? `[{"type":"tool_use","id":"${p.id}","name":"x","input":{}}]`,
      p.turn ?? null, p.conv ?? null, p.thread ?? null, p.servedBy ?? null, p.channel ?? null, p.sourceAgent ?? null,
      1_790_000_000_000 + seq * 1000, 1_790_000_000_000 + seq * 1000);
}
function turn(db: Database.Database, n: number, kind: string, subjectId: string | null, source: string | null): void {
  db.prepare(`INSERT INTO turns (agent_id, turn_number, kind, subject_kind, subject_id, source_message_id, started_at, ended_at, exit_reason, answered)
              VALUES (?, ?, NULL, ?, ?, ?, datetime('now'), datetime('now'), 'answered', 1)`).run(A, n, kind, subjectId, source);
}

/** The adversarial body. Every own row's id names what it is and what 188 must make of it. */
function seedAdversarialBody(db: Database.Database): void {
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, 'A', 'idle', datetime('now'))`).run(A);
  for (const [id, ch, cp] of [[OWNER_CONV, 'dashboard', 'owner'], [OTHER_CONV, 'imessage', '+15550100'], [MAIL_CONV, 'email', 'x@example.com']]) {
    db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))`).run(id, A, ch, cp);
  }
  // Inbound the turns served (NOT own rows — 188 must leave them NULL).
  row(db, { id: 'in-owner', role: 'user', conv: OWNER_CONV, channel: 'dashboard', content: 'owner ask', servedBy: 1 });
  // A CONTACT's ask whose turn the late stamp missed: its reconstructed row belongs to ANOTHER
  // conversation, and must stay in the owner's view anyway (it was NULL, so it was kept).
  row(db, { id: 'in-owner-2', role: 'user', conv: OTHER_CONV, channel: 'imessage', content: 'contact ask', servedBy: 2 });
  row(db, { id: 'in-peer', role: 'user', lane: 'a2a', thread: 'thread-served-0001', sourceAgent: A, content: 'peer asks', servedBy: 5 });
  row(db, { id: 'in-mail', role: 'user', conv: MAIL_CONV, channel: 'email', content: 'a notice' });
  row(db, { id: 'sys-1', role: 'system', content: '[System: a note]', turn: 1 });
  // Turn records.
  turn(db, 1, 'conv', 'owner', 'in-owner');       // a person's turn, late stamp DID run
  turn(db, 2, 'conv', 'imessage:+15550100', 'in-owner-2');  // a person's turn the late stamp MISSED
  turn(db, 3, 'continuation', 'owner', null);     // missed, and nothing to reconstruct from
  turn(db, 4, 'a2a_thread', 'thread-on-turn-0001', null);  // terminal wake: thread on the record
  turn(db, 5, 'a2a_thread', null, null);           // reply-needed: thread only on the served peer row
  turn(db, 6, 'engine_event', 'ev-1', null);
  turn(db, 7, 'none', null, null);                 // the email wake
  turn(db, 8, 'a2a_thread', null, null);           // nothing anywhere names the thread
  // Own rows.
  row(db, { id: 'own-conv-stamped', role: 'assistant', turn: 1, conv: OWNER_CONV, content: 'here you go' });
  row(db, { id: 'own-conv-other', role: 'assistant', turn: 1, conv: OTHER_CONV, content: 'reply to a contact' });
  row(db, { id: 'own-legacy', role: 'tool', turn: 2 });
  row(db, { id: 'own-legacy-unknown', role: 'assistant', turn: 3 });
  row(db, { id: 'own-a2a-turnthread', role: 'assistant', lane: 'a2a', turn: 4 });
  row(db, { id: 'own-a2a-served', role: 'tool', lane: 'a2a', turn: 5 });
  row(db, { id: 'own-a2a-kept-thread', role: 'assistant', lane: 'a2a', turn: 5, thread: 'thread-already-0001' });
  row(db, { id: 'own-a2a-nothread', role: 'assistant', lane: 'a2a', turn: 8 });
  row(db, { id: 'own-engine', role: 'assistant', turn: 6 });
  row(db, { id: 'own-background', role: 'tool', turn: 7 });
  row(db, { id: 'own-turnless', role: 'assistant', turn: null });
  row(db, { id: 'own-orphan-turn', role: 'tool', turn: 99 });
}

const EXPECTED: Record<string, { kind: string | null; conv?: string | null; thread?: string | null }> = {
  'own-conv-stamped': { kind: 'conv', conv: OWNER_CONV },
  'own-conv-other': { kind: 'conv', conv: OTHER_CONV },
  'own-legacy': { kind: 'legacy', conv: OTHER_CONV },
  'own-legacy-unknown': { kind: 'unknown', conv: null },
  'own-a2a-turnthread': { kind: 'a2a_thread', thread: 'thread-on-turn-0001' },
  'own-a2a-served': { kind: 'a2a_thread', thread: 'thread-served-0001' },
  'own-a2a-kept-thread': { kind: 'a2a_thread', thread: 'thread-already-0001' },
  'own-a2a-nothread': { kind: 'a2a_thread', thread: null },
  'own-engine': { kind: 'engine_event' },
  'own-background': { kind: 'background' },
  'own-turnless': { kind: 'unknown' },
  'own-orphan-turn': { kind: 'unknown' },
  'in-owner': { kind: null }, 'in-peer': { kind: null }, 'in-mail': { kind: null }, 'sys-1': { kind: null },
};

let db: Database.Database;
beforeEach(() => {
  db = migrated();
  mockDb.current = db;
  seq = 0;
  seedAdversarialBody(db);
});
afterEach(() => { db.close(); mockDb.current = null; });

const ownerCp: TurnCounterparty = { kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard', senderId: 'owner', threadId: null, senderIsAgent: false };

describe('migration 188 — the legacy rows are labelled once', () => {
  it('runs on the chain (the column exists, with its CHECK)', () => {
    const col = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'messages'`).get() as { sql: string }).sql;
    expect(col).toMatch(/subject_kind TEXT/);
    expect(() => db.prepare(`UPDATE messages SET subject_kind = 'mine' WHERE id = 'own-engine'`).run()).toThrow(/CHECK/);
  });

  it('every statement touches rows on the adversarial body — no branch is untested (G13)', () => {
    const [alter, ...body] = statements();
    expect(alter).toMatch(/^ALTER TABLE messages ADD COLUMN subject_kind/);
    const counts = body.map((sql) => ({ sql: sql.split('\n')[0].slice(0, 60), changes: db.prepare(sql).run().changes }));
    // The temp-table builds and their indexes report 0 by SQLite's definition; every UPDATE must bite.
    const updates = counts.filter((c) => c.sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(7);
    for (const u of updates) expect(u.changes, `branch never exercised: ${u.sql}`).toBeGreaterThan(0);
    expect(updates.map((u) => u.changes)).toEqual([
      2,  // (1) person replies the late stamp DID write -> conv
      3,  // (2a) a2a rows whose thread was NULL: two derived (turn record, served peer row), one stays NULL; the row that already had one is untouched
      4,  // (2b) a2a rows -> a2a_thread
      1,  // (3) engine
      1,  // (4) background (the email wake)
      1,  // (5) legacy, conversation reconstructed from the trigger
      3,  // (6) unknown: the unreconstructable person turn, the turnless row, the orphan turn
    ]);
  });

  it('labels every own row as the vocabulary says, and leaves inbound/system rows NULL', () => {
    db.exec(fs.readFileSync(FILE, 'utf8').replace(/^ALTER TABLE[\s\S]*?;/m, ''));
    for (const [id, want] of Object.entries(EXPECTED)) {
      const r = db.prepare('SELECT subject_kind, conversation_id, a2a_thread_id FROM messages WHERE id = ?').get(id) as
        { subject_kind: string | null; conversation_id: string | null; a2a_thread_id: string | null };
      expect(r.subject_kind, id).toBe(want.kind);
      if ('conv' in want) expect(r.conversation_id, id).toBe(want.conv);
      if ('thread' in want) expect(r.a2a_thread_id, id).toBe(want.thread);
    }
    const nulls = db.prepare(`SELECT count(*) AS n FROM messages WHERE role IN ('assistant','tool') AND subject_kind IS NULL`).get() as { n: number };
    expect(nulls.n, 'no own row is left NULL').toBe(0);
  });

  it('is idempotent by its predicate: a second pass touches nothing', () => {
    const [, ...body] = statements();
    for (const sql of body) db.prepare(sql).run();
    const second = body.map((sql) => ({ sql, n: db.prepare(sql).run().changes }))
      .filter((r) => r.sql.startsWith('UPDATE')).map((r) => r.n);
    expect(second).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('MEMBERSHIP DOES NOT MOVE: the owner conversation keeps exactly the own rows it kept before 188', () => {
    const own = (): Array<{ id: string; conversation_id: string | null }> =>
      db.prepare(`SELECT id, conversation_id FROM messages WHERE role IN ('assistant','tool') ORDER BY seq`).all() as Array<{ id: string; conversation_id: string | null }>;
    // The PRE-188 rule, re-stated as the oracle: an unstamped row was "mine", a stamped one
    // was kept only in its own conversation.
    const before = own().filter((r) => !r.conversation_id || r.conversation_id === OWNER_CONV).map((r) => r.id).sort();
    db.exec(fs.readFileSync(FILE, 'utf8').replace(/^ALTER TABLE[\s\S]*?;/m, ''));
    const tail = getRecentMessages(A, 500);
    const kinds = subjectKindsBySeq(A, tail.map((m) => m.rowid!));
    const labelled = tail.map((m) => ({ ...m, subjectKind: kinds.get(m.rowid!) ?? null }));
    const after = scopeToHumanConversation(labelled, ownerCp, OWNER_CONV, null)
      .filter((m) => m.role === 'assistant' || m.role === 'tool').map((m) => m.id).sort();
    expect(after).toEqual(before);
    // And the reconstructed row is now labelled with its real conversation while staying in view.
    expect(after).toContain('own-legacy');
    expect(after).not.toContain('own-conv-other');
  });
});
