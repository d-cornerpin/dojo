// PHASE-2 T13 Step 0, RULING 12 — migration `135`'s `opened_at` floor is CLAMPED, not defaulted.
//
// THE DEFECT THIS FILE EXISTS FOR. `work.opened_at` carries `CHECK (opened_at > 1600000000000)`
// and `135` filled it from a bare `COALESCE(created_at, updated_at, completed_at, 1600000000001)`
// ladder. That handles an UNREADABLE instant and NOT a readable one that lands below the floor:
// a `tasks.created_at` of '1999-01-01' parses fine, converts to 915148800000, fails the CHECK,
// and aborts the file — which in a real boot aborts the whole migration chain and therefore the
// startup. Migration `138:87-99` met exactly this on a planted row during its own rehearsal and
// fixed it for ITS rows; `135` carried the hazard for four more migrations. T12's Entry 12
// Part 2 handed it back as a product fix and RULING 12 assigned it here.
//
// WHY THE CHAIN IS REPLAYED RATHER THAN A FIXTURE HAND-ROLLED. The pre-`135` schema is 134
// migrations deep and the whole question is what the SHIPPED file does to a REAL 134-era body.
// A hand-built `tasks` table would drift from the one `135` reads, and a source scan (does the
// text contain `MAX(`?) is the class of check T10F caught passing for a reason that had stopped
// being the reason. So this file applies the real files in order up to `134`, seeds rows only
// SQLite can then judge, applies `135`, and reads the result.
//
// The strong proof of the fix is the three-body rehearsal recorded in the T13 report (the
// owner's lived-in 2026-07-26 body at chain 124 and the `pre-127` body, planted and unplanted,
// 56 assertions). This file is the permanent tripwire that stops the clamp being removed again.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations');

/** The CHECK's boundary and the sentinel one millisecond above it, both read from `135`. */
const FLOOR = 1_600_000_000_000;
const SENTINEL = 1_600_000_000_001;

const FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/**
 * The chain starts at `002`; the base tables are the runner's own first `db.exec()` in
 * `migrations.ts` (effectively "migration 001"). It is READ FROM THAT FILE rather than copied
 * here, because a copied base schema is a fixture that drifts — the exact objection this file's
 * header makes. Extraction failure throws: it can never degrade into a silent pass.
 */
function baseSchemaFromRunner(): string {
  const src = fs.readFileSync(path.join(HERE, '..', 'migrations.ts'), 'utf-8');
  const start = src.indexOf('db.exec(`');
  const end = src.indexOf('`);', start);
  if (start < 0 || end < 0) throw new Error('could not locate the base schema in migrations.ts');
  const ddl = src.slice(start + 'db.exec(`'.length, end);
  const tables = (ddl.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
  if (!ddl.includes('CREATE TABLE IF NOT EXISTS agents') || tables < 6) {
    throw new Error(`base schema extraction looks wrong: ${tables} table(s)`);
  }
  return ddl;
}

/** Apply the real chain, in order, up to and including `upTo`. Mirrors the product runner:
 *  one transaction per file, `foreign_keys` OFF for the whole run (`migrations.ts:154`). */
function applyChainUpTo(db: Database.Database, upTo: string): void {
  db.pragma('foreign_keys = OFF');
  db.exec(baseSchemaFromRunner());
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  for (const f of FILES) {
    if (f > upTo) break;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8');
    db.transaction(() => {
      // `019_agent_sdk_auth.sql` is a no-op marker whose real SQL is inline in the runner
      // (`migrations.ts:167`). It rebuilds `providers`/`models`, neither of which `135` reads.
      if (f !== '019_agent_sdk_auth.sql') db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    })();
  }
}

function applyOne(db: Database.Database, file: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  })();
}

const TASK_134 = '134_created_by_kind.sql';
const SPINE = '135_work_spine.sql';

let db: Database.Database;

/**
 * A tracker row at a chosen `created_at`. Only the columns `135` actually reads for the
 * timestamp mapping are set; everything else takes the shipped default, so the fixture cannot
 * drift out from under the migration it is feeding.
 *
 * Neither table has an `agent_id` — `135` derives it (`COALESCE(assigned_to, created_by)` for
 * tasks, `created_by` for projects), which is why the seeds carry `assigned_to`/`created_by`.
 * Measured off `PRAGMA table_info` at 134 rather than assumed; the first draft of this file
 * assumed `agent_id` and the DB refused it.
 */
function seedTask(id: string, createdAt: string | null, over: Record<string, string | null> = {}): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, assigned_to, created_by, created_at, updated_at, completed_at)
     VALUES (@id, @title, @status, 'a1', 'a1', @created_at, @updated_at, @completed_at)`,
  ).run({
    id, title: 't-' + id, status: over.status ?? 'in_progress',
    created_at: createdAt, updated_at: over.updated_at ?? createdAt,
    completed_at: over.completed_at ?? null,
  });
}

function seedProject(id: string, createdAt: string | null, over: Record<string, string | null> = {}): void {
  db.prepare(
    `INSERT INTO projects (id, title, status, created_by, created_at, updated_at, completed_at)
     VALUES (@id, @title, @status, 'a1', @created_at, @updated_at, @completed_at)`,
  ).run({
    id, title: 'p-' + id, status: over.status ?? 'active',
    created_at: createdAt, updated_at: over.updated_at ?? createdAt,
    completed_at: over.completed_at ?? null,
  });
}

const openedAt = (id: string): number | undefined =>
  (db.prepare('SELECT opened_at FROM work WHERE id = ?').get(id) as { opened_at: number } | undefined)?.opened_at;

beforeEach(() => {
  db = new Database(':memory:');
  applyChainUpTo(db, TASK_134);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')`).run();
});

afterEach(() => { db.close(); });

describe('the pre-135 chain is what this file thinks it is', () => {
  it('POSITIVE: `tasks` and `projects` are live tables at 134, and `work` does not exist yet', () => {
    const names = new Set((db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    ).all() as { name: string }[]).map((r) => r.name));
    expect(names.has('tasks')).toBe(true);
    expect(names.has('projects')).toBe(true);
    expect(names.has('work')).toBe(false);
    expect(
      (db.prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1').get() as { name: string }).name,
    ).toBe(TASK_134);
  });

  it('POSITIVE: the CHECK the clamp exists for is really on the column `135` creates', () => {
    applyOne(db, SPINE);
    const ddl = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='work'`,
    ).get() as { sql: string }).sql;
    expect(ddl).toContain(`CHECK (opened_at > ${FLOOR})`);
  });
});

describe('a READABLE pre-2020 tracker timestamp must not abort the chain', () => {
  it('POSITIVE: a task created in 1999 migrates, at the floor sentinel rather than in 1999', () => {
    seedTask('t-1999', '1999-01-01 00:00:00');
    expect(() => applyOne(db, SPINE)).not.toThrow();
    expect(openedAt('t-1999')).toBe(SENTINEL);
  });

  it('POSITIVE: a PROJECT created in 1999 migrates too — the two ladders are separate code', () => {
    seedProject('p-1999', '1999-01-01 00:00:00');
    expect(() => applyOne(db, SPINE)).not.toThrow();
    expect(openedAt('p-1999')).toBe(SENTINEL);
  });

  it('POSITIVE: one second below the boundary is still below it — the edge is not off by one', () => {
    // 1600000000 = 2020-09-13T12:26:40Z. One second earlier converts to exactly FLOOR - 1000.
    seedTask('t-edge', '2020-09-13 12:26:39');
    expect(() => applyOne(db, SPINE)).not.toThrow();
    expect(openedAt('t-edge')).toBe(SENTINEL);
  });

  it('NEGATIVE (the guard must not swallow good data): a 2026 timestamp is carried, NOT clamped', () => {
    seedTask('t-now', '2026-07-30 01:02:03');
    applyOne(db, SPINE);
    const at = openedAt('t-now')!;
    expect(at).toBeGreaterThan(FLOOR);
    expect(at).not.toBe(SENTINEL);
    expect(at).toBe(Math.floor(Date.UTC(2026, 6, 30, 1, 2, 3) / 1000) * 1000);
  });

  it('NEGATIVE (no regression on the case the bare COALESCE was written for): an UNREADABLE '
    + 'timestamp still takes the sentinel path', () => {
    seedTask('t-junk', 'not-a-date', { updated_at: 'also-not', completed_at: null });
    applyOne(db, SPINE);
    expect(openedAt('t-junk')).toBe(SENTINEL);
  });

  it('POSITIVE: a mixed body migrates whole — nothing is dropped and no row lands below the floor', () => {
    seedTask('t-a', '1999-01-01 00:00:00');
    seedTask('t-b', '2026-07-01 00:00:00');
    seedTask('t-c', 'not-a-date');
    seedProject('p-a', '1970-01-01 00:00:01');
    seedProject('p-b', '2026-07-02 00:00:00');
    applyOne(db, SPINE);
    for (const id of ['t-a', 't-b', 't-c', 'p-a', 'p-b']) expect(openedAt(id)).toBeDefined();
    expect(
      (db.prepare(`SELECT count(*) c FROM work WHERE opened_at <= ?`).get(FLOOR) as { c: number }).c,
    ).toBe(0);
  });
});

describe('the sibling time columns are deliberately NOT clamped', () => {
  // `closed_at` and `updated_at` carry no CHECK. Rewriting a readable historical instant the
  // schema CAN store would falsify when the owner did something, so the clamp is scoped to the
  // one column whose constraint makes an unrepresentable value fatal.
  it('POSITIVE: a completed 1999 task keeps its real closed_at while opened_at is clamped', () => {
    seedProject('p-old', '1999-01-01 00:00:00', { completed_at: '1999-02-01 00:00:00' });
    db.prepare(`UPDATE projects SET status='complete' WHERE id='p-old'`).run();
    applyOne(db, SPINE);
    const r = db.prepare('SELECT opened_at, closed_at, updated_at FROM work WHERE id = ?')
      .get('p-old') as { opened_at: number; closed_at: number; updated_at: number };
    expect(r.opened_at).toBe(SENTINEL);
    expect(r.closed_at).toBe(Math.floor(Date.UTC(1999, 1, 1) / 1000) * 1000);
    expect(r.closed_at).toBeLessThan(FLOOR);
  });
});
