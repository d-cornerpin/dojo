// ════════════════════════════════════════════════════════════════════════════════════════
// AN OPEN DELEGATION IS CLOSED BY THE CHAIN, IN THE PRODUCT'S OWN WORDS.
// (UPDATE-INTEGRITY U0, change 2 — `135c_stable_close_open_parks.sql` and the runner's
//  REQUIRES-COLUMN guard.)
//
// ── THE TWO THINGS THIS PROVES ──────────────────────────────────────────────────────────
//
//   1. ON A BODY THAT STILL HAS `messages.conv_key`, every `park:%` key becomes
//      `relayed:failed:%` — the exact rewrite `consumeParkAndDeliver(…, {failedClosed:true})`
//      performs — and NOTHING else moves. Single parks, the fan-out form, and neighbouring
//      `relayed:` / `relayed:failed:` / `owner` / NULL keys that must be left alone.
//
//   2. ON A BODY THAT NO LONGER HAS THE COLUMN — anything that completed the .17 chain,
//      where `148` dropped it — the file is a CLEAN NO-OP through the REAL runner. This is
//      the half that is easy to get wrong and impossible to fix later: a pending repair file
//      prepared against a dropped column throws `no such column: conv_key`, which is the
//      same bricked boot the repair exists to end, moved thirteen files down the chain.
//      SQLite resolves names at PREPARE time, so the guard cannot live in the SQL — measured
//      below, so the runner-side guard is a decision with evidence rather than a preference.
//
// The runner half is driven through `runMigrations()` itself, not a re-implementation: the
// claim is about what a real boot does with a real pending set.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockDb } = vi.hoisted(() => ({ mockDb: { current: null as Database.Database | null } }));

vi.mock('../connection.js', async () => {
  const actual = await vi.importActual<typeof import('../connection.js')>('../connection.js');
  return {
    ...actual,
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
  };
});

import { runMigrations } from '../migrations.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');
const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const BRIDGE = '135b_stable_work_spine.sql';
const CLOSER = '135c_stable_close_open_parks.sql';
const DROP_CONV_KEY = '148_drop_messages_conv_key.sql';
const LAST = FILES[FILES.length - 1];

function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  const ddl = src.slice(start + 'db.exec(`'.length, end);
  if (!ddl.includes('CREATE TABLE IF NOT EXISTS agents')) throw new Error('base schema extraction looks wrong');
  return ddl;
}

/** Apply the real chain, in order, up to and including `upTo`, skipping `skip`. */
function applyChainUpTo(db: Database.Database, upTo: string, skip: readonly string[] = []): void {
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > upTo) break;
    if (skip.includes(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    db.transaction(() => {
      if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
  db.pragma('foreign_keys = ON');
}

function applyOne(db: Database.Database, file: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  })();
}

let db: Database.Database;

afterEach(() => { mockDb.current = null; db?.close(); });

function seedKey(id: string, convKey: string | null): void {
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, conv_key)
     VALUES (?, 'a1', 'assistant', 'body of ' || ?, ?)`,
  ).run(id, id, convKey);
}

const keyOf = (id: string): string | null => (db.prepare(
  'SELECT conv_key FROM messages WHERE id = ?',
).get(id) as { conv_key: string | null }).conv_key;

const contentOf = (id: string): string => (db.prepare(
  'SELECT content FROM messages WHERE id = ?',
).get(id) as { content: string }).content;

// ────────────────────────────────────────────────────────────────────────────────────────

describe('the file sorts where the repair belongs', () => {
  it('POSITIVE: after 135b, before 147 reads the column and before 148 drops it', () => {
    const at = FILES.indexOf(CLOSER);
    expect(at).toBeGreaterThan(FILES.indexOf(BRIDGE));
    expect(at).toBeLessThan(FILES.indexOf('147_conversation_identity_backfill.sql'));
    expect(at).toBeLessThan(FILES.indexOf(DROP_CONV_KEY));
    // Adjacent to the bridge it repairs: nothing may be inserted between them by accident.
    expect(FILES[FILES.indexOf(BRIDGE) + 1]).toBe(CLOSER);
  });
});

describe('a park crossing the bridge lands as a failed-closed delegation', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    applyChainUpTo(db, BRIDGE, [CLOSER]);
    db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')`).run();
  });

  it('POSITIVE: a single park becomes `relayed:failed:<thread>`, content untouched', () => {
    seedKey('m-park', 'park:t-abc123');
    applyOne(db, CLOSER);
    expect(keyOf('m-park')).toBe('relayed:failed:t-abc123');
    expect(contentOf('m-park')).toBe('body of m-park');
  });

  it('POSITIVE: the FAN-OUT form keeps every character after the sigil', () => {
    seedKey('m-fan', 'park:~t1|t2|t3#t2');
    applyOne(db, CLOSER);
    expect(keyOf('m-fan')).toBe('relayed:failed:~t1|t2|t3#t2');
  });

  it('POSITIVE: no `park:%` key survives the file, on a body full of them', () => {
    seedKey('m-p1', 'park:t1');
    seedKey('m-p2', 'park:~t1|t2#t2');
    seedKey('m-p3', 'park:t3');
    applyOne(db, CLOSER);
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE conv_key LIKE 'park:%'`)
      .get() as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE conv_key LIKE 'relayed:failed:%'`)
      .get() as { c: number }).c).toBe(3);
  });

  it('NEGATIVE: keys that are not parks are not touched — including already-closed ones', () => {
    seedKey('m-rel', 'relayed:t9');
    seedKey('m-fail', 'relayed:failed:t8');
    seedKey('m-owner', 'owner');
    seedKey('m-join', 'join-piece:t7');
    seedKey('m-null', null);
    seedKey('m-parky', 'parking-lot:t6');   // starts with 'park' but is not the sigil
    const before = (db.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c;
    applyOne(db, CLOSER);
    expect(keyOf('m-rel')).toBe('relayed:t9');
    expect(keyOf('m-fail')).toBe('relayed:failed:t8');
    expect(keyOf('m-owner')).toBe('owner');
    expect(keyOf('m-join')).toBe('join-piece:t7');
    expect(keyOf('m-null')).toBeNull();
    expect(keyOf('m-parky')).toBe('parking-lot:t6');
    expect((db.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c).toBe(before);
  });

  it('POSITIVE: the rest of the chain then completes to the end, with the parks closed', () => {
    seedKey('m-p1', 'park:t1');
    seedKey('m-p2', 'park:~t1|t2#t2');
    mockDb.current = db;
    expect(() => runMigrations()).not.toThrow();
    expect((db.prepare('SELECT count(*) c FROM _migrations').get() as { c: number }).c)
      .toBe(FILES.length);
    expect((db.prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1')
      .get() as { name: string }).name).toBe(LAST);
    expect((db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check)
      .toBe('ok');
    // 148 dropped the column, so the keys are gone with it — but the rows are still here.
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE id IN ('m-p1','m-p2')`)
      .get() as { c: number }).c).toBe(2);
  });
});

describe('on a body that already completed the .17 chain, the file is a clean no-op', () => {
  beforeEach(() => {
    // The completed-.17 fingerprint: every file applied EXCEPT this repair, which did not
    // exist when that box ran its chain. `messages.conv_key` was dropped at 148.
    db = new Database(':memory:');
    applyChainUpTo(db, LAST, [CLOSER]);
    db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')`).run();
    db.prepare(
      `INSERT INTO messages (id, agent_id, role, content) VALUES ('m-old','a1','assistant','kept')`,
    ).run();
  });

  it('POSITIVE: the body really is post-drop and really is missing only this file', () => {
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('messages')`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(cols).not.toContain('conv_key');
    const applied = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[])
      .map((r) => r.name));
    expect(applied.has(DROP_CONV_KEY)).toBe(true);
    expect(applied.has(CLOSER)).toBe(false);
    expect(applied.size).toBe(FILES.length - 1);
  });

  it('POSITIVE: the real runner completes, records the file, and changes nothing', () => {
    mockDb.current = db;
    expect(() => runMigrations()).not.toThrow();
    const row = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(CLOSER);
    expect(row).toBeDefined();
    expect((db.prepare('SELECT count(*) c FROM _migrations').get() as { c: number }).c)
      .toBe(FILES.length);
    expect((db.prepare(`SELECT content FROM messages WHERE id='m-old'`)
      .get() as { content: string }).content).toBe('kept');
    expect((db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check)
      .toBe('ok');
  });

  it('POSITIVE: a SECOND boot is a no-op too — the file is not retried forever', () => {
    mockDb.current = db;
    runMigrations();
    const first = (db.prepare('SELECT applied_at FROM _migrations WHERE name = ?')
      .get(CLOSER) as { applied_at: string }).applied_at;
    expect(() => runMigrations()).not.toThrow();
    expect((db.prepare('SELECT applied_at FROM _migrations WHERE name = ?')
      .get(CLOSER) as { applied_at: string }).applied_at).toBe(first);
  });
});

describe('the evidence for putting the guard in the runner rather than in the SQL', () => {
  it('MEASURED: SQLite resolves the column at PREPARE time, so no in-SQL guard can work', () => {
    // The strongest in-SQL guard available is a trigger body that is never fired. It still
    // fails, because preparing the INSERT that would fire it compiles the trigger program.
    // This is why `135c` carries a REQUIRES-COLUMN line instead of a `WHERE EXISTS`.
    const probe = new Database(':memory:');
    probe.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY);`);
    expect(() => probe.exec(`
      CREATE TEMP TABLE _gate (n INTEGER);
      CREATE TEMP TRIGGER _fire AFTER INSERT ON _gate BEGIN
        UPDATE messages SET conv_key = 'x' WHERE conv_key LIKE 'park:%';
      END;
      INSERT INTO _gate (n) SELECT 1
        WHERE EXISTS (SELECT 1 FROM pragma_table_info('messages') WHERE name = 'conv_key');
    `)).toThrow(/no such column: conv_key/);
    probe.close();
  });

  it('POSITIVE: the file declares the requirement the runner reads', () => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, CLOSER), 'utf-8');
    expect(sql).toMatch(/^--\s*REQUIRES-COLUMN:\s*messages\.conv_key\s*$/m);
  });

  it('NEGATIVE: the guard does NOT fire when the column is present — the file really runs', () => {
    db = new Database(':memory:');
    applyChainUpTo(db, BRIDGE, [CLOSER]);
    db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')`).run();
    seedKey('m-park', 'park:t1');
    mockDb.current = db;
    runMigrations();
    // If the guard had skipped it, this row would still say `park:` at 147 and lose its key
    // at 148 with nothing recorded. Read the proof off the chain's own product instead: the
    // repair ran, so no park was ever seen by 147.
    expect((db.prepare('SELECT checksum FROM _migrations WHERE name = ?').get(CLOSER) as
      { checksum: string | null }).checksum).not.toBeNull();
    expect((db.prepare('SELECT count(*) c FROM _migrations').get() as { c: number }).c)
      .toBe(FILES.length);
  });
});
