// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — MIGRATION 192 LABELS THE NOTES ALREADY ON A BOX, ONCE, AND QUEUES ONLY THE RECENT MIXED ONES.
//
// Rehearsed per G13 on an ADVERSARIAL body: one-conversation notes of every key (a person's
// conversation, an agent thread, engine events, a background wake, a row on record as unknown), a note
// over only system rows, mixed notes either side of the 14-day line, a mixed note straddling it, a note
// whose rows are all gone, a note whose rows are PARTLY gone, a condensed note over two one-conversation
// leaves of the same conversation and one over leaves of two — beside rows that must not move. Each
// UPDATE is run alone with its `changes` counted; a zero means a branch never exercised. A second pass
// touches nothing. The same statements, re-run by the nightly job for notes an older version wrote, are
// the job's only classifier (`classifyUnlabelledNotes`), so there is one rule.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: () => { /* not exercised */ },
}));

import { runMigrations } from '../../db/migrations.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, '..', '..', 'db', 'migrations', '192_summaries_rebuild_state.sql');
const A = 'agent-192';
const DAY = 86_400_000;
const NOW = Date.now();

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
/** The file's statements, comments stripped, from the classification on (the DDL already ran). */
function body(): string[] {
  const sql = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  return sql.slice(sql.indexOf('CREATE TEMP TABLE t192_desc')).split(';').map((s) => s.trim()).filter(Boolean);
}

let db: Database.Database;
let seq = 0;
function msg(p: { role: string; lane?: string; conv?: string | null; thread?: string | null; source?: string | null; kind?: string | null; daysAgo: number }): string {
  seq += 1;
  const id = `m192-${seq}`;
  db.prepare(`INSERT INTO messages (id, agent_id, role, lane, content, conversation_id, a2a_thread_id, source_agent_id, subject_kind, created_at, sent_at)
              VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, ?, ?)`)
    .run(id, A, p.role, p.lane ?? 'owner', p.conv ?? null, p.thread ?? null, p.source ?? null, p.kind ?? null, NOW - p.daysAgo * DAY + seq, NOW - p.daysAgo * DAY + seq);
  return id;
}
function note(id: string, ids: string[]): void {
  db.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at) VALUES (?, ?, 0, 'leaf', ?, 10, '2026-10-01 00:00:00', '2026-10-02 00:00:00')`).run(id, A, `note ${id}`);
  for (const m of ids) db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)').run(id, m);
}
function parent(id: string, kids: string[]): void {
  db.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at) VALUES (?, ?, 1, 'condensed', ?, 10, '2026-10-01 00:00:00', '2026-10-02 00:00:00')`).run(id, A, `parent ${id}`);
  for (const k of kids) db.prepare('INSERT INTO summary_parents (summary_id, parent_id) VALUES (?, ?)').run(id, k);
}

const EXPECTED: Record<string, { key?: string | null; state?: string | null }> = {
  'conv-only':       { key: 'conv:c-dash', state: null },
  'thread-only':     { key: 'a2a:t-1', state: null },
  'engine-only':     { key: 'engine', state: null },
  'background-only': { key: 'background', state: null },
  'unknown-only':    { key: 'unknown', state: null },
  'system-only':     { key: 'unknown', state: null },
  'mixed-recent':    { key: null, state: 'legacy_mixed_rebuild' },
  'mixed-13d':       { key: null, state: 'legacy_mixed_rebuild' },
  'mixed-15d':       { key: null, state: 'legacy_mixed' },
  'mixed-straddle':  { key: null, state: 'legacy_mixed' },
  'gone':            { key: null, state: 'lineage_lost' },
  'partly-gone':     { key: 'conv:c-dash', state: null },
  'p-same':          { key: 'conv:c-dash', state: null },
  'p-mixed':         { key: null, state: 'legacy_mixed_rebuild' },
  'already':         { key: 'conv:c-mail', state: null },
};

beforeEach(() => {
  seq = 0;
  db = migrated();
  mockDb.current = db;
  db.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Depot', 'idle', '{}')").run(A);
  note('conv-only', [msg({ role: 'user', conv: 'c-dash', daysAgo: 2 }), msg({ role: 'assistant', conv: 'c-dash', kind: 'conv', daysAgo: 2 })]);
  note('thread-only', [msg({ role: 'user', lane: 'a2a', thread: 't-1', source: 'peer', daysAgo: 2 }), msg({ role: 'assistant', lane: 'a2a', thread: 't-1', kind: 'a2a_thread', daysAgo: 2 })]);
  note('engine-only', [msg({ role: 'user', lane: 'events', daysAgo: 2 }), msg({ role: 'tool', kind: 'engine_event', daysAgo: 2 })]);
  note('background-only', [msg({ role: 'assistant', kind: 'background', daysAgo: 2 })]);
  note('unknown-only', [msg({ role: 'assistant', kind: 'unknown', daysAgo: 2 }), msg({ role: 'user', daysAgo: 2 })]);
  note('system-only', [msg({ role: 'system', daysAgo: 2 })]);
  note('mixed-recent', [msg({ role: 'user', conv: 'c-dash', daysAgo: 2 }), msg({ role: 'system', daysAgo: 2 }), msg({ role: 'user', conv: 'c-mail', daysAgo: 1 })]);
  note('mixed-13d', [msg({ role: 'user', conv: 'c-dash', daysAgo: 13 }), msg({ role: 'assistant', kind: 'engine_event', daysAgo: 13 })]);
  note('mixed-15d', [msg({ role: 'user', conv: 'c-dash', daysAgo: 15 }), msg({ role: 'assistant', kind: 'engine_event', daysAgo: 15 })]);
  note('mixed-straddle', [msg({ role: 'user', conv: 'c-dash', daysAgo: 20 }), msg({ role: 'user', conv: 'c-mail', daysAgo: 3 })]);
  note('gone', []);
  const keep = msg({ role: 'user', conv: 'c-dash', daysAgo: 2 });
  const lost = msg({ role: 'user', conv: 'c-mail', daysAgo: 2 });
  note('partly-gone', [keep, lost]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(lost);   // ON DELETE CASCADE drops the link, as a deleted conversation does
  note('leaf-s1', [msg({ role: 'user', conv: 'c-dash', daysAgo: 4 })]);
  note('leaf-s2', [msg({ role: 'assistant', conv: 'c-dash', kind: 'conv', daysAgo: 4 })]);
  parent('p-same', ['leaf-s1', 'leaf-s2']);
  note('leaf-m1', [msg({ role: 'user', conv: 'c-dash', daysAgo: 4 })]);
  note('leaf-m2', [msg({ role: 'user', conv: 'c-mail', daysAgo: 4 })]);
  parent('p-mixed', ['leaf-m1', 'leaf-m2']);
  note('already', [msg({ role: 'user', conv: 'c-dash', daysAgo: 2 })]);
  db.prepare("UPDATE summaries SET subject_key = 'conv:c-mail' WHERE id = 'already'").run();   // labelled before: untouched
});
afterEach(() => { db.close(); mockDb.current = null; });

describe('migration 192 — the notes already on a box', () => {
  it('runs on the chain: the two columns (rebuild_state CHECKed) and the staging table exist', () => {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'summaries'").get() as { sql: string }).sql;
    expect(sql).toMatch(/subject_key TEXT/);
    expect(() => db.prepare("UPDATE summaries SET rebuild_state = 'mixed' WHERE id = 'gone'").run()).toThrow(/CHECK/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'summary_rebuild_staged'").get()).toBeTruthy();
  });

  it('every UPDATE touches rows on the adversarial body — no branch untested (G13)', () => {
    expect(runBody()).toEqual([
      // (2) one conversation: conv-only, thread-only, engine-only, background-only, unknown-only, partly-gone,
      //     leaf-s1, leaf-s2, p-same, leaf-m1, leaf-m2
      11,
      1,  // (3) system-only
      3,  // (4) mixed-recent, mixed-13d, p-mixed
      2,  // (5) mixed-15d, mixed-straddle
      1,  // (6) gone
    ]);
  });

  it('labels every note as the states say, and leaves an already-labelled note alone', () => {
    runBody();
    for (const [id, want] of Object.entries(EXPECTED)) {
      const r = db.prepare('SELECT subject_key, rebuild_state FROM summaries WHERE id = ?').get(id) as { subject_key: string | null; rebuild_state: string | null };
      expect({ key: r.subject_key, state: r.rebuild_state }, id).toEqual({ key: want.key, state: want.state });
    }
    expect((db.prepare('SELECT COUNT(*) AS k FROM summaries WHERE subject_key IS NULL AND rebuild_state IS NULL').get() as { k: number }).k).toBe(0);
  });

  it('is idempotent by its predicate: a second pass touches nothing', () => {
    runBody();
    expect(runBody()).toEqual([0, 0, 0, 0, 0]);
  });

  it('touches no message and no link (original messages are never touched)', () => {
    const before = db.prepare('SELECT COUNT(*) AS m, (SELECT COUNT(*) FROM summary_messages) AS l, (SELECT group_concat(content) FROM messages) AS c FROM messages').get();
    runBody();
    expect(db.prepare('SELECT COUNT(*) AS m, (SELECT COUNT(*) FROM summary_messages) AS l, (SELECT group_concat(content) FROM messages) AS c FROM messages').get()).toEqual(before);
  });

  it('ONE RULE: the nightly job re-runs exactly these statements for notes a downgraded version wrote', async () => {
    const { CLASSIFY_SQL } = await import('../legacy-notes-rebuild.js');
    expect(CLASSIFY_SQL.split(';').map((x) => x.trim()).filter(Boolean)).toEqual(body());
  });

  it('on a VACUUM INTO file copy, as the release rehearsal runs it', () => {
    const dir = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 't144-192-'));
    const file = path.join(dir, 'copy.db');
    db.exec(`VACUUM INTO '${file}'`);
    const copy = new Database(file);
    try {
      const changes = body().map((s) => (s.startsWith('UPDATE') ? copy.prepare(s).run().changes : (copy.exec(s), -1))).filter((c) => c >= 0);
      expect(changes).toEqual([11, 1, 3, 2, 1]);
    } finally {
      copy.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function runBody(): number[] {
  const out: number[] = [];
  for (const s of body()) {
    if (s.startsWith('UPDATE')) out.push(db.prepare(s).run().changes);
    else db.exec(s);
  }
  return out;
}
