// ════════════════════════════════════════════════════════════════════════════
// MIGRATION 153 (`grant_rule`) — THE THREE REHEARSAL BODIES, AS A TEST.
//
// The rehearsal-body rider says a migration is rehearsed on a worn-in body, a
// control, and an ADVERSARIAL body carrying planted duplicates / NULLs /
// orphans. That rehearsal caught a real defect in this file's first draft — a
// `CREATE TABLE IF NOT EXISTS` that was a NO-OP against a pre-existing loose
// table, so a box would have recorded `153` as applied while carrying none of
// the constraints `153` exists to give it. A clean body blessed it.
//
// This file is that rehearsal made permanent, so the next person who edits the
// migration meets the adversarial body rather than a paragraph about it.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '153_grant_rule.sql'),
  'utf-8',
);

/** Apply the file the way `db/migrations.ts` applies it: one `exec`, one
 *  transaction, foreign keys OFF for the chain. */
function apply(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => db.exec(MIGRATION))();
  db.pragma('foreign_keys = ON');
}

function bodyControl(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, permissions TEXT);`);
  return db;
}

function bodyWornIn(): Database.Database {
  const db = bodyControl();
  const insert = db.prepare('INSERT INTO agents (id, permissions) VALUES (?, ?)');
  insert.run('primary', '{"file_read":"*","file_write":"*"}');
  for (let i = 0; i < 20; i++) {
    insert.run(`worker-${i}`, i % 3 === 0 ? '{}' : '{"file_read":["~/Projects/**"]}');
  }
  return db;
}

/** The body that killed the first draft: a LOOSE `grant_rule` with no CHECKs,
 *  no NOT NULLs and no unique index, carrying duplicates, a NULL-everything row,
 *  orphans naming a deleted agent, and a stale ESCALATION row. */
function bodyAdversarial(): Database.Database {
  const db = bodyWornIn();
  db.exec(`
    CREATE TABLE grant_rule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT, effect_kind TEXT, mode TEXT, pattern TEXT,
      source TEXT DEFAULT 'manifest', manifest_fingerprint TEXT, created_at TEXT
    );
    INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, source, manifest_fingerprint) VALUES
      ('worker-1','fs_read','allow','*','manifest','stale'),
      ('worker-1','fs_read','allow','*','manifest','stale'),
      ('worker-1','fs_read','allow','*','manifest','stale'),
      ('worker-1',NULL,NULL,NULL,NULL,NULL),
      ('deleted-agent','shell','allow','*','manifest','stale'),
      ('deleted-agent','net','allow','*','manifest','stale'),
      ('worker-1','shell','allow','*','manifest','stale');
  `);
  return db;
}

function tableSql(db: Database.Database): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='grant_rule'").get() as { sql: string } | undefined;
  return row?.sql ?? '';
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='grant_rule' AND name LIKE 'grant_rule%'").all() as { name: string }[])
    .map((r) => r.name).sort();
}

describe('migration 153 — the three bodies all end in the same shape', () => {
  for (const [label, make] of [
    ['control (no agents, no prior table)', bodyControl],
    ['worn-in (21 agents, mixed manifests)', bodyWornIn],
    ['ADVERSARIAL (loose table, 7 planted rows)', bodyAdversarial],
  ] as const) {
    it(`applies to the ${label} body and lands every guarantee`, () => {
      const db = make();
      expect(() => apply(db)).not.toThrow();

      // The table exists with its constraints — this is the clause the first
      // draft failed on the adversarial body while passing on the other two.
      const sql = tableSql(db);
      expect(sql, 'effect_kind must carry its CHECK').toMatch(/CHECK \(effect_kind IN/);
      expect(sql, 'mode must carry its CHECK').toMatch(/CHECK \(mode IN \('allow', 'deny'\)\)/);
      expect(sql, 'pattern must be NOT NULL').toMatch(/pattern TEXT NOT NULL/);
      expect(sql, 'the fingerprint is what makes drift impossible; it may never be nullable')
        .toMatch(/manifest_fingerprint TEXT NOT NULL/);

      expect(indexNames(db)).toEqual(['grant_rule_lookup', 'grant_rule_unique']);

      // Empty on purpose (see the migration header and Bridge Entry 32): the
      // rows are a projection and only the platform can compute the fingerprint.
      const rows = (db.prepare('SELECT COUNT(*) AS n FROM grant_rule').get() as { n: number }).n;
      expect(rows, 'the table starts empty on every body, planted rows included').toBe(0);

      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check(grant_rule)').all()).toEqual([]);
      db.close();
    });
  }
});

describe('migration 153 — the constraints bite, and precedence is the query', () => {
  const seeded = (): Database.Database => {
    const db = bodyWornIn();
    apply(db);
    return db;
  };
  const insert = (db: Database.Database, kind: string, mode: string, pattern: string | null): void => {
    db.prepare(
      'INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, manifest_fingerprint) VALUES (?,?,?,?,?)',
    ).run('worker-1', kind, mode, pattern, 'fp');
  };

  it('refuses an effect_kind outside the broker vocabulary', () => {
    const db = seeded();
    expect(() => insert(db, 'not_a_kind', 'allow', '*')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('refuses a mode that is neither allow nor deny', () => {
    const db = seeded();
    expect(() => insert(db, 'fs_read', 'maybe', '*')).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('refuses a NULL pattern — a rule with no pattern reads as a rule that does something', () => {
    const db = seeded();
    expect(() => insert(db, 'fs_read', 'allow', null)).toThrow(/NOT NULL constraint failed/);
    db.close();
  });

  it('refuses a duplicated rule', () => {
    const db = seeded();
    insert(db, 'fs_read', 'allow', '*');
    expect(() => insert(db, 'fs_read', 'allow', '*')).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('ORDER BY mode DESC hands back every DENY before every ALLOW', () => {
    // This is the whole reason the grant is rows: deny-wins stops being a thing
    // the reader has to remember and becomes a property of the query.
    const db = seeded();
    insert(db, 'fs_read', 'allow', '*');
    insert(db, 'fs_read', 'deny', '~/.ssh/**');
    insert(db, 'fs_read', 'allow', '~/Projects/**');
    const order = (db.prepare(
      "SELECT mode, pattern FROM grant_rule WHERE agent_id='worker-1' AND effect_kind='fs_read' ORDER BY mode DESC, id ASC",
    ).all() as { mode: string; pattern: string }[]).map((r) => `${r.mode} ${r.pattern}`);
    expect(order).toEqual(['deny ~/.ssh/**', 'allow *', 'allow ~/Projects/**']);
    db.close();
  });

  it('the CASCADE removes an agent\'s rules with the agent (foreign_keys ON)', () => {
    const db = seeded();
    insert(db, 'fs_read', 'allow', '*');
    db.prepare('DELETE FROM agents WHERE id = ?').run('worker-1');
    expect((db.prepare('SELECT COUNT(*) AS n FROM grant_rule').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
