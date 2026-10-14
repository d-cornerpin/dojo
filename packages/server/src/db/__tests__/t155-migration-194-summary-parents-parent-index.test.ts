// ════════════════════════════════════════════════════════════════════════════════════════
// t155 B — MIGRATION 194: `summary_parents(parent_id)` GETS ITS INDEX. THE PLAN IS THE CLAUSE.
//
// `summary_parents` (002) is keyed (summary_id, parent_id), so a lookup by `parent_id` has no
// index and scans the table. The nightly legacy-note rebuild asks "is this note a parent of
// anything" once per queued note, as a correlated subquery, so its cost was queued-notes x
// table-size (measured in the v3.3.3 cut checks: 12.7 s, synchronous, at 1,000 notes over 277k
// links; the same query is 25 ms with the index).
//
// These clauses do not assert "an index exists". They run the REAL migration chain on a fresh
// body, grow `summaries` / `summary_parents` to a size where a scan is a decision rather than
// an accident, and read the query PLAN of every statement that looks a row up by `parent_id`
// — the SQL text is lifted from the source file it lives in, and a pin clause fails if the
// source stops carrying that text, so this file cannot keep passing against a copy.
//
// ALSO: an aged body (a box at 193) upgrades through the real runner, a later boot is a no-op,
// no row changes, and the counterfactual (index dropped) shows the same plans scanning again.
// Every id below is fictional and generated.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..');
const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t155-migration-194');
const FILE = '194_summary_parents_parent_index.sql';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t155-migration-194');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t155-migration-194', 'dojo.db'),
  };
});

import { runMigrations } from '../migrations.js';

// Each clause runs the full migration chain; an import cost, not a timing assertion.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** Every statement that looks `summary_parents` up by `parent_id`: the file it lives in, and its SQL. */
const SHAPES: ReadonlyArray<{ name: string; file: string; sql: string; params: number }> = [
  {
    name: 'queuedUnits: is this queued note a parent of anything (correlated, once per note)',
    file: 'memory/legacy-notes-rebuild.ts',
    sql: `SELECT id, agent_id, token_count FROM summaries
      WHERE rebuild_state = 'legacy_mixed_rebuild' AND NOT EXISTS (SELECT 1 FROM summary_parents sp WHERE sp.parent_id = summaries.id)
      ORDER BY agent_id, earliest_at, id`,
    params: 0,
  },
  {
    name: 'swapAgent: is this note still on top',
    file: 'memory/legacy-notes-rebuild.ts',
    sql: 'SELECT 1 FROM summary_parents WHERE parent_id = ? LIMIT 1',
    params: 1,
  },
  {
    name: 'memory route: the children of a summary',
    file: 'gateway/routes/memory.ts',
    sql: 'SELECT summary_id FROM summary_parents WHERE parent_id = ?',
    params: 1,
  },
  {
    name: 'dag.deleteSummary / uncondensed-head / memory route: the OR-delete',
    file: 'memory/dag.ts',
    sql: 'DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?',
    params: 2,
  },
];

/** The same text must still stand in the source file, modulo whitespace. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A fresh body migrated by the real runner, grown so a scan is a choice the planner makes on purpose. */
function grownBody(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = OFF');
  d.prepare(`INSERT INTO agents (id, name, status) VALUES ('fx-agent-a', 'Fixture A', 'idle'), ('fx-agent-b', 'Fixture B', 'idle')`).run();
  const insS = d.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at, rebuild_state)
    VALUES (?, ?, ?, 'leaf', 'fixture note', 10, ?, ?, ?)`);
  const insP = d.prepare('INSERT INTO summary_parents (summary_id, parent_id) VALUES (?, ?)');
  d.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      const at = `2026-01-01 00:${String(Math.floor(i / 100) % 60).padStart(2, '0')}:00`;
      insS.run(`fx-sum-${i}`, i % 2 ? 'fx-agent-a' : 'fx-agent-b', i % 4, at, at, i % 5 === 0 ? 'legacy_mixed_rebuild' : null);
      // Each summary after the first 1,000 condenses three earlier ones: 15,000 links.
      if (i >= 1000 && i % 2 === 0) for (const k of [1, 2, 3]) insP.run(`fx-sum-${i}`, `fx-sum-${i - k * 7}`);
    }
  })();
  d.pragma('foreign_keys = ON');
  return d;
}

const planOf = (d: Database.Database, sql: string, params: number): string =>
  (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(params).fill('fx-sum-1500')) as Array<{ detail: string }>)
    .map((r) => r.detail).join(' | ');

describe('the lookups really are the ones in the source', () => {
  for (const shape of SHAPES) {
    it(`${shape.name} — pinned to ${shape.file}`, () => {
      expect(squash(fs.readFileSync(path.join(SRC, shape.file), 'utf-8'))).toContain(squash(shape.sql));
    });
  }
  it('the two other OR-deletes carry the same text (uncondensed-head, the memory route)', () => {
    const or = squash('DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?');
    for (const f of ['memory/uncondensed-head.ts', 'gateway/routes/memory.ts']) {
      expect(squash(fs.readFileSync(path.join(SRC, f), 'utf-8')), f).toContain(or);
    }
  });
});

describe('migration 194: no lookup by parent_id scans summary_parents', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}`, () => {
      const p = planOf(grownBody(), shape.sql, shape.params);
      expect(p).not.toMatch(/SCAN (sp|summary_parents)\b/);
      expect(p).toMatch(/idx_summary_parents_parent_id/);
    });
  }

  it('the purge-an-agent delete (IN-subquery form of the same OR) also seeks by parent_id', () => {
    const p = planOf(grownBody(),
      `DELETE FROM summary_parents
        WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)
           OR parent_id  IN (SELECT id FROM summaries WHERE agent_id = ?)`, 2);
    expect(p).not.toMatch(/SCAN summary_parents/);
    expect(p).toMatch(/idx_summary_parents_parent_id/);
  });

  it('the OR-delete still deletes both directions (a row where the id is the child AND one where it is the parent)', () => {
    const d = grownBody();
    const before = (d.prepare("SELECT COUNT(*) AS n FROM summary_parents WHERE summary_id = 'fx-sum-1500' OR parent_id = 'fx-sum-1500'").get() as { n: number }).n;
    const total = (d.prepare('SELECT COUNT(*) AS n FROM summary_parents').get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);
    const r = d.prepare('DELETE FROM summary_parents WHERE summary_id = ? OR parent_id = ?').run('fx-sum-1500', 'fx-sum-1500');
    expect(r.changes).toBe(before);
    expect((d.prepare('SELECT COUNT(*) AS n FROM summary_parents').get() as { n: number }).n).toBe(total - before);
  });

  it('COUNTERFACTUAL: with the index dropped the same plans scan again — the clauses above bite', () => {
    const d = grownBody();
    d.exec('DROP INDEX idx_summary_parents_parent_id');
    for (const shape of SHAPES) {
      expect(planOf(d, shape.sql, shape.params), shape.name).toMatch(/SCAN (sp|summary_parents)\b/);
    }
  });
});

describe('the upgrade door', () => {
  it('an aged body at 193 takes 194 on the next boot through the real runner; the next boot is a no-op; no row changes', () => {
    const d = grownBody();
    // A box from before 194: the index is absent and 194 is not recorded.
    d.exec('DROP INDEX idx_summary_parents_parent_id');
    d.prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
    const digest = (): string => JSON.stringify([
      d.prepare('SELECT * FROM summaries ORDER BY id').all(),
      d.prepare('SELECT * FROM summary_parents ORDER BY summary_id, parent_id').all(),
    ]);
    const before = digest();
    const idx = (): number => (d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_summary_parents_parent_id'").get() as { n: number }).n;
    expect(idx()).toBe(0);

    runMigrations(); // the update's boot
    expect(idx()).toBe(1);
    expect(d.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE)).toEqual({ n: 1 });
    expect(digest()).toBe(before);
    expect(d.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    const applied = (d.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
    runMigrations(); // a later boot
    expect((d.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name)).toEqual(applied);
    expect(idx()).toBe(1);
    expect(digest()).toBe(before);
  });

  it('composes with a hand-made twin: the file is guarded, re-applying it is silent', () => {
    const d = grownBody();
    const sql = fs.readFileSync(path.join(SRC, 'db', 'migrations', FILE), 'utf-8');
    expect(() => d.exec(sql)).not.toThrow();
    expect(() => d.exec(sql)).not.toThrow();
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'summary_parents'").get() as { n: number }).n).toBe(2); // the PK's auto-index + this one
  });
});
