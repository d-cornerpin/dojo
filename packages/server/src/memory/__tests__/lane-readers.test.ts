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
import fs from 'node:fs';
import path from 'node:path';

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
    work: null,
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

// ── 3. Every rowid a reader emits is a `messages.seq` ──
//
// vault/archive.ts turns `Message.rowid` into `vault_conversations.latest_rowid`, the
// per-agent archive high-water. A reader that puts any OTHER number into that array can hand
// the vault a high-water far above any real message, and every later archive then skips
// genuine history — a silent loss in the Dreamer feed. One table, one keyspace.
//
// CONVERTED AT T10 (roadmap #2), not dropped. This test used to seed a row into
// `inter_agent_messages` with rowid 999999 to give the assertion something to catch.
// Migration 133 drops that table, so the fixture would fail to PREPARE — and deleting the
// test with it would drop the guard. The property survives in its structural form: every
// emitted rowid must be a seq that is actually PRESENT in `messages`. That is strictly
// stronger than the old `<= MAX(seq)` bound (which a foreign number below the maximum would
// have passed) and it needs no second table to be capable of failing.

describe('the archive high-water reads one keyspace', () => {
  it('every rowid a tail loader emits is a seq in messages', () => {
    for (let i = 0; i < 8; i++) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', content: `owner ${i}` });
    }
    insertMessage({
      agentId: AGENT, role: 'user', lane: 'a2a', sourceAgentId: PEER,
      a2aThreadId: 'thread-lane-2', a2aIntent: 'QUESTION', content: 'peer asks something',
    });

    const seqs = new Set(
      (mockDb.current!.prepare('SELECT seq FROM messages').all() as Array<{ seq: number }>)
        .map(r => r.seq),
    );
    const outside = getMessagesOutsideFreshTail(AGENT, 2);
    const rowids = outside.map((m) => m.rowid).filter((r): r is number => typeof r === 'number');

    expect(rowids.length).toBeGreaterThan(0);
    for (const r of rowids) {
      expect(seqs.has(r), `rowid ${r} is not a seq in messages — a foreign keyspace reached the high-water`).toBe(true);
    }
  });
});

// ── 4. The insertion key has ONE name in SQL ──
//
// PHASE-1 T10, migration 133. `seq` is now `INTEGER PRIMARY KEY AUTOINCREMENT`, i.e. the
// table's rowid alias. SQLite therefore names the result column of a bare `SELECT rowid FROM
// messages` **`seq`**, not `rowid` — measured, and asserted directly in message-store.test.ts.
// Same value, different name, so a `row.rowid` read against such a query is `undefined` and
// NOTHING THROWS: better-sqlite3 returns the object, TypeScript's declared row shape is a cast
// and cannot see it, and the caller quietly behaves as though there were no row. That is the
// failure mode that broke 45 tests silently on T3's first attempt at this promotion.
//
// The rule that neutralises it: any reader that wants the key under the name the shared
// `Message` type uses projects `seq AS rowid`. This walk refuses a bare one. It is the reason
// the promotion could be a mechanical change rather than a careful one.
//
// METHOD NOTE, worth keeping: comments are stripped BEFORE literals are extracted. A prose
// apostrophe ("don't") otherwise opens a bogus single-quoted string and desynchronises every
// later match in the file — which is exactly how the first version of this scan silently
// missed `agent/v2/loop.ts`'s ten-column projection, the largest one in the tree.

const SRC_ROOT = path.join(__dirname, '..', '..');

/** Replace comment bodies with spaces, preserving offsets and line numbers. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'migrations') continue; tsFiles(fp, acc); }
    else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}

const LITERAL = /`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
const SELECT_FROM = /\bSELECT\b([\s\S]*?)\bFROM\b([\s\S]{0,60})/gi;
const NAMES_MESSAGES = /(^|[^_\w])messages\b/;

/** Does this SELECT-list carry a `rowid` whose RESULT COLUMN NAME is decided by SQLite?
 *
 *  Two spellings are safe and both had to be learned by being flagged wrongly:
 *    * `seq AS rowid` — the trailing token IS `rowid`, but it is an alias NAME, so it names
 *      the column regardless of what the PK is called. (Flagged every converted site.)
 *    * `rowid AS _rowid` — an explicit alias on the rowid itself; same guarantee, other way
 *      round. (Flagged `gateway/routes/interagent.ts`, which was already correct.)
 *  Both are removed before the question is asked; anything left is a bare projection. */
function projectsBareRowid(selectList: string): boolean {
  const explicit = selectList
    .replace(/(?:\b\w+\.)?\browid\b\s+AS\s+\w+/gi, '')   // rowid AS <name>
    .replace(/\bAS\s+rowid\b/gi, '');                     // <expr> AS rowid
  return /(?:\b\w+\.)?\browid\b/i.test(explicit);
}

/** Same-file `const NAME = \`…\`` SQL fragments, so an interpolated projection list can be
 *  resolved before the walk asks what it projects.
 *
 *  This is not defensive generality — it is the repair for a real miss. `WAITING_COLS` in
 *  `agent/v2/counterparty.ts` opened with a bare `rowid` and is interpolated into four
 *  queries, so the token never appeared beside a `FROM messages` and a literal-only walk
 *  reported the tree clean. The 45 integration tests that went red on the promotion's first
 *  run are what found it. A rule that cannot see through one level of interpolation is a rule
 *  with a hole exactly where this codebase puts its column lists. */
function sqlConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(`(?:[^`\\]|\\[\s\S])*`)/g)) {
    out.set(m[1], m[2].slice(1, -1));
  }
  return out;
}

describe('the insertion key has one name in SQL (T10 — `seq` is the rowid alias)', () => {
  /** Every SELECT-list bare `rowid` over `messages`, as `file:line`. */
  function offenders(): string[] {
    const out: string[] = [];
    for (const abs of tsFiles(SRC_ROOT)) {
      const src = stripComments(fs.readFileSync(abs, 'utf8'));
      const consts = sqlConstants(src);
      for (const lit of src.matchAll(LITERAL)) {
        // Resolve one level of same-file constant interpolation. Offsets are preserved for
        // line reporting by scanning the ORIGINAL literal for the SELECT positions.
        const resolved = lit[0].replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) =>
          consts.has(name) ? consts.get(name)! : whole);
        if (!/\browid\b/i.test(resolved)) continue;
        const base = src.slice(0, lit.index).split('\n').length;
        for (const s of resolved.matchAll(SELECT_FROM)) {
          if (!NAMES_MESSAGES.test(s[2])) continue;
          if (!projectsBareRowid(s[1])) continue;
          out.push(`${path.relative(SRC_ROOT, abs).split(path.sep).join('/')}:${base}`);
        }
      }
    }
    return [...new Set(out)].sort();
  }

  it('no reader projects a bare `rowid` from `messages` — every one says `seq AS rowid`', () => {
    expect(
      offenders(),
      'a bare `rowid` projection is named `seq` in the result and reads back as undefined — project `seq AS rowid`',
    ).toEqual([]);
  });

  it('the walk can actually see a violation (the rule is not vacuous)', () => {
    // The same matcher, run against the shape it exists to refuse and the shapes it must
    // allow. Without this, an over-narrowed regex reports a clean tree forever — and this
    // one WAS over-narrow on its first run, in the opposite direction.
    //
    // The offending column name is assembled at runtime rather than written out, because
    // the walk above reads THIS FILE too and a literal counterexample would make the rule
    // permanently red. There is no allowlist, deliberately: the rule has no holes, so the
    // one file that must contain the bad shape does not contain it as a literal.
    const KEY = 'row' + 'id';
    const check = (sql: string) => {
      for (const s of sql.matchAll(SELECT_FROM)) {
        if (NAMES_MESSAGES.test(s[2]) && projectsBareRowid(s[1])) return true;
      }
      return false;
    };
    expect(check(`SELECT ${KEY}, content FROM messages WHERE id = ?`)).toBe(true);
    expect(check(`SELECT m.${KEY}, m.id FROM messages AS m`)).toBe(true);
    expect(check('SELECT seq AS rowid, content FROM messages WHERE id = ?')).toBe(false);
    expect(check('SELECT m.seq AS rowid, m.agent_id FROM messages AS m')).toBe(false);
    // A predicate or an ORDER BY is not a projection: the name never reaches TypeScript.
    expect(check(`SELECT id FROM messages WHERE ${KEY} = ? ORDER BY ${KEY} DESC`)).toBe(false);
    // Another table's rowid is not this rule's business.
    expect(check(`SELECT ${KEY}, id FROM summaries WHERE agent_id = ?`)).toBe(false);
  });

  it('an interpolated column list is resolved, not skipped (the miss that cost 45 red tests)', () => {
    const KEY = 'row' + 'id';
    const file = [
      `const COLS = \`${KEY}, id, content\`;`,
      'const q = db.prepare(`SELECT ${COLS} FROM messages WHERE agent_id = ?`);',
    ].join('\n');
    const consts = sqlConstants(file);
    expect(consts.get('COLS'), 'the constant collector must see a same-file SQL fragment')
      .toContain(KEY);
    const query = 'SELECT ${COLS} FROM messages WHERE agent_id = ?'
      .replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (w, n: string) => consts.get(n) ?? w);
    let seen = false;
    for (const s of query.matchAll(SELECT_FROM)) {
      if (NAMES_MESSAGES.test(s[2]) && projectsBareRowid(s[1])) seen = true;
    }
    expect(seen, 'a bare rowid hidden behind one level of interpolation must still be seen').toBe(true);
  });
});
