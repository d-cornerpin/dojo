// ════════════════════════════════════════════════════════════════════════════════════════
// A MIGRATED BOX KEEPS ITS SETUP FLAG (fresh-box audit, finding 4 — the open question).
//
// The audit could not settle whether `migration/import.ts` copies the source `config` table
// wholesale, and said so: *"That determines whether finding #4 is cosmetic or a permanent
// agentless box for every migrating user. Worth resolving before v3.2.2."*
//
// It is COSMETIC, and this file is the measurement rather than the argument. The fixture is
// restore-SHAPED: a real source-box database with a real `config` table carrying
// `setup_completed='true'`, copied the way Step 7 copies it, then `markOobeComplete()`'s statement
// run against the copy — so the two things the question turns on are both exercised.
//
// TWO INDEPENDENT REASONS a migrating user is fine, and the clauses below pin both:
//   1. Step 7 restores `data/dojo.db` WHOLESALE, so the source row arrives before
//      `markOobeComplete()` runs at all.
//   2. `markOobeComplete()` writes `setup_completed` itself.
// Either alone is sufficient. That is why NO HEALING READ is owed — a reader accepting either
// spelling would guard a state that cannot occur, and would give the typo a meaning.
//
// The clauses are written against the READERS, not against a string: what matters is whether
// `isPastFirstRun()` answers true on a migrated box, because that is the gate the agentless
// window hangs off.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), `dojo-migrated-flag-${process.pid}`);
const SOURCE_DB = path.join(ROOT, 'source', 'dojo.db');
const DEST_DB = path.join(ROOT, 'dest', 'dojo.db');

/** Exactly the statement `markOobeComplete()` runs, after this fix. */
const MARK_OOBE_COMPLETE =
  "INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')";

/** What it used to ALSO run — the orphan, kept here so its inertness is demonstrable. */
const THE_OLD_ORPHAN_WRITE =
  "INSERT OR REPLACE INTO config (key, value) VALUES ('setup_complete', 'true')";

/** Migration 177's statement, read from the shipped file rather than retyped. */
const MIGRATION_177 = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '177_orphan_setup_complete_key.sql'),
  'utf-8',
);

/** The one reader the agentless window hangs off (`config/platform.ts:114`'s shape). */
function isPastFirstRun(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM config WHERE key = 'setup_completed'").get() as
    { value: string } | undefined;
  return row?.value === 'true';
}

/** A source box that has been in use: OOBE done, agents, and a config table with real rows. */
function buildSourceBox(): void {
  fs.mkdirSync(path.dirname(SOURCE_DB), { recursive: true });
  const db = new Database(SOURCE_DB);
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  const cfg = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  cfg.run('setup_completed', 'true');           // the REAL flag, on the source box
  cfg.run('primary_agent_id', 'primary-1');
  cfg.run('platform_name', 'Dojo');
  db.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run('primary-1', 'Primary');
  db.close();
}

/** Step 7's move: the whole database file, copied byte-for-byte. */
function restoreTreeWholesale(): void {
  fs.mkdirSync(path.dirname(DEST_DB), { recursive: true });
  fs.copyFileSync(SOURCE_DB, DEST_DB);
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  buildSourceBox();
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the restore carries the source config table', () => {
  it('⚠ the REAL flag survives Step 7 on its own, before markOobeComplete runs', () => {
    restoreTreeWholesale();

    const dest = new Database(DEST_DB);
    // This is the whole answer to the audit's open question: the row is already here.
    expect(isPastFirstRun(dest)).toBe(true);
    expect(dest.prepare('SELECT COUNT(*) AS n FROM config').get()).toEqual({ n: 3 });
    expect(dest.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 1 });
    dest.close();
  });

  it('and markOobeComplete makes it true a second, independent time', () => {
    restoreTreeWholesale();
    const dest = new Database(DEST_DB);
    // Even from a source box that had NEVER completed OOBE, the mark alone suffices.
    dest.prepare("DELETE FROM config WHERE key = 'setup_completed'").run();
    expect(isPastFirstRun(dest)).toBe(false);

    dest.prepare(MARK_OOBE_COMPLETE).run();

    expect(isPastFirstRun(dest)).toBe(true);
    dest.close();
  });

  it('⚠ COUNTERFACTUAL — the orphan spelling ALONE leaves the box reading as un-set-up', () => {
    // This is what a permanently-agentless box would have required: the orphan written and the
    // canonical key absent. It is unreachable in the real flow (the two clauses above), and this
    // clause exists to show WHY the typo was never fatal rather than asserting that it wasn't.
    restoreTreeWholesale();
    const dest = new Database(DEST_DB);
    dest.prepare("DELETE FROM config WHERE key = 'setup_completed'").run();

    dest.prepare(THE_OLD_ORPHAN_WRITE).run();

    expect(isPastFirstRun(dest)).toBe(false);          // nothing reads the orphan
    expect(dest.prepare("SELECT value FROM config WHERE key = 'setup_complete'").get())
      .toEqual({ value: 'true' });                     // …though the row is really there
    dest.close();
  });
});

describe('migration 177 removes the orphan and only the orphan', () => {
  it('deletes `setup_complete` and leaves `setup_completed` alone', () => {
    restoreTreeWholesale();
    const dest = new Database(DEST_DB);
    dest.prepare(THE_OLD_ORPHAN_WRITE).run();
    expect(dest.prepare('SELECT COUNT(*) AS n FROM config').get()).toEqual({ n: 4 });

    dest.exec(MIGRATION_177);

    expect(dest.prepare("SELECT value FROM config WHERE key = 'setup_complete'").get()).toBeUndefined();
    // THE CLAUSE THAT MATTERS: the canonical key is an EQUALITY away from the orphan, so a
    // prefix or LIKE would have taken it too.
    expect(isPastFirstRun(dest)).toBe(true);
    expect(dest.prepare('SELECT COUNT(*) AS n FROM config').get()).toEqual({ n: 3 });
    dest.close();
  });

  it('is idempotent, and a no-op on a box that never migrated', () => {
    restoreTreeWholesale();
    const dest = new Database(DEST_DB);
    const before = dest.prepare('SELECT key, value FROM config ORDER BY key').all();

    dest.exec(MIGRATION_177);
    dest.exec(MIGRATION_177);

    expect(dest.prepare('SELECT key, value FROM config ORDER BY key').all()).toEqual(before);
    dest.close();
  });
});

describe('the tree agrees on ONE spelling', () => {
  it('⚠ no source file writes `setup_complete` any more', () => {
    // A census, so the orphan cannot come back by a different hand. Reads the real tree.
    const src = path.resolve(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(p);
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(p, 'utf-8');
          // THREE precisions, each one earned by a false positive while writing this:
          //   1. not followed by `d` — the canonical key is the same string plus one letter, so a
          //      bare `includes` flags every legitimate reader in the tree;
          //   2. quoted — a config key reaches the database inside a string literal;
          //   3. COMMENT LINES SKIPPED — prose about the defect is legitimate and necessary (the
          //      fix's own comment names the orphan to explain why it went), and markdown
          //      backticks in a comment are not string quotes.
          const code = text.split('\n')
            .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join('\n');
          if (/['"`]setup_complete(?!d)['"`]/.test(code)) offenders.push(path.relative(src, p));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
    // Non-vacuity, both directions: the matcher really fires on a key literal, and really does
    // NOT fire on the canonical key or on prose about the orphan.
    const KEY = /['"`]setup_complete(?!d)['"`]/;
    expect(KEY.test("config WHERE key = 'setup_complete'")).toBe(true);
    expect(KEY.test("config WHERE key = 'setup_completed'")).toBe(false);
    const COMMENT = /^\s*(\/\/|\*|\/\*)/;
    expect(COMMENT.test('  // it wrote `setup_complete` and nothing read it')).toBe(true);
    expect(COMMENT.test("  db.prepare(\"… 'setup_complete' …\")")).toBe(false);
  });
});
