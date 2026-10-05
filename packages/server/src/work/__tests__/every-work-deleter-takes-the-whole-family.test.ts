// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY DELETER OF A WORK ROW TAKES THE WHOLE FAMILY (W2-B items C and D).
//
// ── THE DEFECT THIS FILE WAS WRITTEN FOR ──
// `work/tracker-store.ts`'s `deleteTrackerRow` — the deleter behind the dashboard's
// delete-project and delete-task routes, the memory route's purge, and the scheduler's
// terminal-task prune — swept TWO of the FOUR things that reference `work(id)`. It took
// `work_events` and `adjudications`; it left `techniques.build_project_id` and the
// SELF-reference `work.parent_id` alone.
//
// Because all four references are `NO ACTION`, the consequence is not a stranded row: it is a
// RAISE. Measured at this branch's base, with `foreign_keys = ON` as `db/connection.ts` sets
// it, all three shapes below threw `SqliteError: FOREIGN KEY constraint failed`:
//
//   a grandchild chain      project -> task -> occurrence, deleting the project
//   a technique on the row  a technique whose `build_project_id` names the doomed row
//   a technique on a child  the same, naming one of the doomed row's children
//
// The grandchild shape was known and patched AT ONE CALLER: `gateway/routes/tracker.ts`'s
// project route calls `deleteOccurrencesOf` first, and its own comment says the deleter is
// broken and logs it as a defect. A hole plugged at one of five callers is still a hole, and
// the technique shape is plugged at NONE of them — which matters because a technique is
// built BY a project, so the reference is the normal case for that table rather than an
// exotic one.
//
// ── WHY THE FIX IS THE SHARED LIST, NOT THREE MORE STATEMENTS ──
// `work/work-refs.ts` already exists for exactly this, and its header already records that
// three call sites had three different ideas of the list. `deleteTrackerRow` was the third
// idea. It now calls `clearReferencesToWork` twice — once for the children's family, once for
// the row's own — which is the shape the delete-by-parent predicate needs: the helper NULLS
// `work.parent_id` of everything pointing INTO the set it is given, so handing it the children
// and then deleting `WHERE parent_id = ?` would null the very link the delete selects on.
//
// ── ITEM D: THE CENSUS, AND WHY IT IS TWO CLAUSES AND NOT ONE ──
// `a-deleted-work-row-leaves-no-verdict.test.ts` pins the four references the SCHEMA declares
// and drives the two occurrence paths. That counts both ways on the TABLE axis: a fifth
// reference reds it. It does not count on the DELETER axis — a NEW deleter that forgets a
// reference reds nothing, which is precisely how `deleteTrackerRow` sat here unexamined while
// the occurrence paths were being fixed.
//
// So this file closes the other axis:
//
//   CLAUSE D1 (structure)  enumerate every `DELETE FROM work` site in production source and
//                          require each of its files to clear all four references — by the
//                          shared helper, or by a statement per reference. The required
//                          statements are DERIVED from `PRAGMA foreign_key_list` plus each
//                          column's nullability, so a FIFTH reference makes D1 demand a fifth
//                          sweep rather than passing on a stale hardcoded list of four.
//   CLAUSE D2 (behaviour)  every deleter file names a DRIVER here, the driver set and the
//                          census set must be equal, and each driver is run against a fixture
//                          carrying all four references at once — then `PRAGMA
//                          foreign_key_check` must be empty and no reference may name a
//                          deleted row.
//
// A new deleter therefore fails D1 (unknown file) and D2 (no driver) before it can fail in
// front of a user. All rows and names below are fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-work-deleter-family');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-work-deleter-family', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

import { runMigrations } from '../../db/migrations.js';
import { deleteTrackerRow } from '../tracker-store.js';
import { deleteAllWorkForAgent } from '../purge-sweep.js';
import { deleteOccurrencesOf, OCCURRENCE_KIND } from '../occurrences.js';

const db = (): Database.Database => mockDb.current!;
const NOW = 1_790_000_000_000;

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;
const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

// ── THE SCHEMA'S OWN ANSWER TO "WHAT POINTS AT A WORK ROW" ───────────────────────────────

interface WorkRef { table: string; column: string; onDelete: string; nullable: boolean }

function referencesIntoWork(): WorkRef[] {
  const tables = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  const out: WorkRef[] = [];
  for (const t of tables) {
    const fks = db().prepare(`PRAGMA foreign_key_list("${t}")`).all() as
      Array<{ table: string; from: string; on_delete: string }>;
    const cols = db().prepare(`PRAGMA table_info("${t}")`).all() as
      Array<{ name: string; notnull: number }>;
    for (const fk of fks) {
      if (fk.table !== 'work') continue;
      const col = cols.find(c => c.name === fk.from);
      out.push({ table: t, column: fk.from, onDelete: fk.on_delete, nullable: col?.notnull === 0 });
    }
  }
  return out.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/** What a deleter must SAY about one reference. A reference the row cannot live without is
 *  deleted; one it can is released. Derived, so a fifth reference gets a requirement too. */
const sweepPatternFor = (r: WorkRef): RegExp => r.nullable
  ? new RegExp(String.raw`UPDATE\s+${r.table}\s+SET\s+${r.column}\s*=\s*NULL`, 'i')
  : new RegExp(String.raw`DELETE\s+FROM\s+${r.table}\b`, 'i');

// ── THE SOURCE WALK (CLAUSE D1) ──────────────────────────────────────────────────────────

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'migrations') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts')) acc.push(fp);
  }
  return acc;
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
const read = (r: string): string => fs.readFileSync(path.join(SRC, r), 'utf8');

/** Blank comments, keeping line count, so prose describing a delete is never counted as one. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

/** A statement that removes a row FROM `work` — and not from `work_events`, which the `\b`
 *  is there for, and not an interpolated table name, which is a deleter too. */
const WORK_DELETE_RE = /DELETE\s+FROM\s+(?:work\b(?!_)|\$\{)/i;

/** Routing through the shared list, asserted as a CALL WITH AN ARGUMENT — an import line or a
 *  mention in a comment must not satisfy this (comments are blanked above). */
const HELPER_CALL_RE = /clearReferencesToWork\(\s*[^)\s]/;

const deleterFiles = (): string[] => walk(SRC).map(rel)
  .filter(f => WORK_DELETE_RE.test(stripComments(read(f))))
  .sort();

/** Every deleter file, and the function this file drives to prove it. Equality with the
 *  source census is itself a clause, so a new deleter cannot land undriven. */
const DRIVERS: Record<string, string> = {
  'work/occurrences.ts': 'deleteOccurrencesOf',
  'work/purge-sweep.ts': 'deleteAllWorkForAgent',
  'work/tracker-store.ts': 'deleteTrackerRow',
};

// ── THE FIXTURE: ONE BODY CARRYING ALL FOUR REFERENCES AT ONCE ───────────────────────────

const seedBase = (): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))
  `).run();
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))
  `).run();
  for (const a of ['a-doomed', 'a-bystander']) {
    db().prepare(`
      INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
      VALUES (?,?, 'm1','idle','{}',1,'owner',datetime('now'),datetime('now'))
    `).run(a, a);
  }
};

const seedWork = (id: string, kind: string, parent: string | null, agent = 'a-doomed'): void => {
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, updated_at, sequence)
    VALUES (?, ?, ?, ?, 'owner', 'legacy', 'legacy', 'on_deck', 'FYI', 0, 0, 'a chore', ?, ?, 0)
  `).run(id, kind, parent, agent, NOW, NOW);
};

/** The two dependents a work row owns. */
const seedDependents = (workId: string): void => {
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'owner', ?)`).run(workId, NOW);
  db().prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
                VALUES (?, 'done', 'upheld', 'owner', ?)`).run(workId, NOW);
};

/** The reference nobody thinks about: a technique naming the row that built it. */
const seedTechnique = (id: string, builtBy: string): void => {
  db().prepare(`
    INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
    VALUES (?, 'A technique', 'published', ?, ?, datetime('now'), datetime('now'))
  `).run(id, `/tmp/${id}`, builtBy);
};

/**
 * project -> task -> occurrence, with dependents on all three, a technique on the project and
 * another on the task. Every one of the four references is present, twice over.
 */
const seedTheWholeFamily = (): void => {
  seedWork('proj', 'project', null);
  seedWork('task', 'task', 'proj');
  seedWork('occ', OCCURRENCE_KIND, 'task');
  for (const id of ['proj', 'task', 'occ']) seedDependents(id);
  seedTechnique('t-on-proj', 'proj');
  seedTechnique('t-on-task', 'task');
  // A bystander agent's row, untouched by anything below.
  seedWork('other', 'project', null, 'a-bystander');
  seedDependents('other');
  seedTechnique('t-on-other', 'other');
};

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  db().pragma('foreign_keys = ON');
  expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
  seedBase();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── ITEM C: THE THREE SHAPES THAT RAISED ─────────────────────────────────────────────────

describe('deleteTrackerRow — the three shapes that raised', () => {
  it('⚠ a GRANDCHILD chain: deleting the project does not fail the foreign key', () => {
    seedTheWholeFamily();

    expect(() => deleteTrackerRow('proj')).not.toThrow();

    expect(n('SELECT COUNT(*) AS n FROM work WHERE id IN (?,?)', 'proj', 'task')).toBe(0);
    // The grandchild SURVIVES with its link released — a child work row outlives its parent,
    // which is `work-refs.ts`'s stated policy and what the one-level docstring promises.
    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'occ')).toBe(1);
    expect(db().prepare('SELECT parent_id AS p FROM work WHERE id = ?').get('occ'))
      .toEqual({ p: null });
    expect(fkViolations()).toEqual([]);
  });

  it('⚠ a TECHNIQUE naming the doomed row survives with its link nulled', () => {
    seedTheWholeFamily();

    deleteTrackerRow('proj');

    for (const t of ['t-on-proj', 't-on-task']) {
      expect(n('SELECT COUNT(*) AS n FROM techniques WHERE id = ?', t), t).toBe(1);
      expect(db().prepare('SELECT build_project_id AS b FROM techniques WHERE id = ?').get(t), t)
        .toEqual({ b: null });
    }
  });

  it('⚠ a TECHNIQUE naming a doomed CHILD is the same story, one level down', () => {
    seedWork('proj', 'project', null);
    seedWork('task', 'task', 'proj');
    seedTechnique('t-on-task', 'task');

    expect(() => deleteTrackerRow('proj')).not.toThrow();

    expect(n('SELECT COUNT(*) AS n FROM techniques WHERE build_project_id IS NULL')).toBe(1);
    expect(fkViolations()).toEqual([]);
  });

  it('keeps its contract: the return value counts the ROW, not its children', () => {
    seedTheWholeFamily();
    expect(deleteTrackerRow('proj')).toBe(1);
    expect(deleteTrackerRow('nothing-by-that-id')).toBe(0);
  });

  it('NEGATIVE CONTROL — the bystander agent keeps its row, its dependents and its technique', () => {
    seedTheWholeFamily();

    deleteTrackerRow('proj');

    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'other')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'other')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'other')).toBe(1);
    expect(db().prepare('SELECT build_project_id AS b FROM techniques WHERE id = ?').get('t-on-other'))
      .toEqual({ b: 'other' });
  });
});

// ── ITEM D: THE DELETER CENSUS, BOTH WAYS ────────────────────────────────────────────────

describe('the deleter census — no path that deletes a work row is unexamined', () => {
  it('names every `DELETE FROM work` site in production source, so a new one is visible', () => {
    const found = deleterFiles();
    expect(found).toEqual(Object.keys(DRIVERS).sort());
    // Non-vacuity: an empty walk would pass every clause below it.
    expect(found.length).toBeGreaterThan(0);
  });

  it('the walk is not blind — it sees a planted deleter and ignores a commented one', () => {
    expect(WORK_DELETE_RE.test(stripComments("db.prepare('DELETE FROM work WHERE id = ?')"))).toBe(true);
    expect(WORK_DELETE_RE.test(stripComments('// DELETE FROM work — described, never run'))).toBe(false);
    // `work_events` is a different table and must not read as this one, either way round.
    expect(WORK_DELETE_RE.test("DELETE FROM work_events WHERE work_id = ?")).toBe(false);
    // The helper call must be a CALL. An import or a bare mention is not one.
    expect(HELPER_CALL_RE.test("import { clearReferencesToWork } from './work-refs.js';")).toBe(false);
    expect(HELPER_CALL_RE.test('clearReferencesToWork(doomed);')).toBe(true);
  });

  it('CLAUSE D1 — every deleter clears every reference the SCHEMA declares', () => {
    const refs = referencesIntoWork();
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(r.onDelete, `${r.table}.${r.column}`).toBe('NO ACTION');

    for (const file of deleterFiles()) {
      const src = stripComments(read(file));
      if (HELPER_CALL_RE.test(src)) continue;   // routed through the one list
      for (const r of refs) {
        expect(sweepPatternFor(r).test(src),
          `${file} deletes work rows but never clears ${r.table}.${r.column}`).toBe(true);
      }
    }
  });

  it('CLAUSE D2 — every deleter file names a driver, and the two sets are equal', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(deleterFiles());
  });

  it('⚠ CLAUSE D2 — each driver leaves NO reference naming a row it deleted', async () => {
    const drive: Record<string, () => void> = {
      'work/tracker-store.ts': () => { deleteTrackerRow('proj'); },
      'work/purge-sweep.ts': () => { deleteAllWorkForAgent('a-doomed'); },
      'work/occurrences.ts': () => { deleteOccurrencesOf(['task']); },
    };
    // Equality with DRIVERS, so a driver added to the table above cannot be left unrun.
    expect(Object.keys(drive).sort()).toEqual(Object.keys(DRIVERS).sort());

    for (const [file, run] of Object.entries(drive)) {
      mockDb.current?.close();
      mockDb.current = new Database(':memory:');
      // eslint-disable-next-line no-await-in-loop
      await runMigrations();
      db().pragma('foreign_keys = ON');
      seedBase();
      seedTheWholeFamily();
      const before = (db().prepare('SELECT id FROM work ORDER BY id').all() as Array<{ id: string }>)
        .map(r => r.id);

      expect(() => run(), `${file}: ${DRIVERS[file]} raised`).not.toThrow();

      const after = new Set((db().prepare('SELECT id FROM work ORDER BY id').all() as Array<{ id: string }>)
        .map(r => r.id));
      const gone = before.filter(id => !after.has(id));
      expect(gone.length, `${file}: ${DRIVERS[file]} deleted nothing — the drive is vacuous`)
        .toBeGreaterThan(0);

      for (const id of gone) {
        for (const r of referencesIntoWork()) {
          expect(n(`SELECT COUNT(*) AS n FROM "${r.table}" WHERE "${r.column}" = ?`, id),
            `${file}: ${r.table}.${r.column} still names deleted row ${id}`).toBe(0);
        }
      }
      expect(fkViolations(), `${file}: left a foreign-key violation`).toEqual([]);
    }
  });
});
