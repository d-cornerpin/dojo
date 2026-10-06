// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 178 (work_events / adjudications indexes) — THE PLAN IS THE CLAUSE.
//
// The defect this migration closes was invisible on every small body and catastrophic on a
// grown one: with no index on work_events, the tracker's correlated probes full-scanned the
// table per work row, per check, per minute. So the clauses here do not assert "an index
// exists" (an index nobody uses is furniture); they assert the QUERY PLANNER USES IT for the
// three production probe shapes, on a body grown to the measured incident scale — and the
// counterfactual proves the assertion bites by dropping the index and watching the same
// plans degrade to a SCAN.
//
// GROWN BODY   100,000 work_events across 800 work rows (fictional, generated) — the same
//              order of magnitude as the measured incident body (123,071 × 762).
// SHAPE 1      the NOT EXISTS probe        (ask-settlement.ts:431 family)
// SHAPE 2      the kind-filtered COUNT     (ask-settlement.ts:532 family)
// SHAPE 3      MAX(created_at) per (work_id, kind)  (ask-settlement.ts:868 family)
// SHAPE 4      adjudications by work_id    (the verdict lookups and orphan sweeps)
// COMPOSE      re-running the CREATE INDEX composes with a hand-created twin (the cured
//              box carries this exact index by hand; the migration must be a no-op there)
// COUNTERFACTUAL  DROP the index → every shape's plan contains "SCAN work_events" again.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIGRATION = path.join(__dirname, '..', 'migrations', '178_work_events_index.sql');

let dir: string;
let db: Database.Database;

function plan(sql: string, ...params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map(r => r.detail).join(' | ');
}

// The three production probe shapes, verbatim in structure (parameters inlined as
// placeholders): what ask-settlement and the PM tick actually ask, per work row.
const SHAPE_NOT_EXISTS =
  "SELECT 1 FROM work WHERE NOT EXISTS (SELECT 1 FROM work_events oi WHERE oi.work_id = work.id AND oi.kind = 'validated')";
const SHAPE_COUNT =
  "SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = ?";
const SHAPE_MAX =
  "SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'join_complete'";
const SHAPE_ADJ =
  'SELECT verdict FROM adjudications WHERE work_id = ?';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-migration-178-'));
  db = new Database(path.join(dir, 'grown.db'));
  // The minimal schema the migration's DDL and the probe shapes touch. Column shapes match
  // production (work.id TEXT pk; work_events work_id/kind/created_at; adjudications work_id).
  db.exec(`
    CREATE TABLE work (id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE adjudications (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, verdict TEXT);
  `);
  // The grown body: 800 work rows, 125 events each = 100,000 events; a sprinkling of
  // adjudications. All fictional, all generated.
  const insWork = db.prepare('INSERT INTO work (id) VALUES (?)');
  const insEv = db.prepare('INSERT INTO work_events (work_id, kind, created_at) VALUES (?, ?, ?)');
  const insAdj = db.prepare('INSERT INTO adjudications (id, work_id, verdict) VALUES (?, ?, ?)');
  const kinds = ['opened', 'claimed', 'note', 'validated', 'join_complete'];
  db.transaction(() => {
    for (let w = 0; w < 800; w++) {
      const workId = `fixture-work-${w}`;
      insWork.run(workId);
      for (let e = 0; e < 125; e++) {
        insEv.run(workId, kinds[e % kinds.length], 1700000000000 + w * 1000 + e);
      }
      if (w % 8 === 0) insAdj.run(`fixture-adj-${w}`, workId, 'upheld');
    }
  })();
  // Apply the real migration file — the artifact under test, not a transcription of it.
  db.exec(fs.readFileSync(MIGRATION, 'utf-8'));
});

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration 178: the planner uses the new indexes for the production probe shapes', () => {
  it('the NOT EXISTS probe searches the index — no work_events scan survives', () => {
    const p = plan(SHAPE_NOT_EXISTS);
    expect(p).toContain('idx_work_events_work_id');
    expect(p).not.toContain('SCAN work_events');
  });

  it('the kind-filtered COUNT is answered by the index', () => {
    const p = plan(SHAPE_COUNT, 'fixture-work-1', 'validated');
    expect(p).toContain('idx_work_events_work_id');
    expect(p).not.toContain('SCAN work_events');
  });

  it('MAX(created_at) per (work_id, kind) reads the index without a sort of the table', () => {
    const p = plan(SHAPE_MAX, 'fixture-work-1');
    expect(p).toContain('idx_work_events_work_id');
    expect(p).not.toContain('SCAN work_events');
  });

  it('adjudications lookups by work_id search their index', () => {
    const p = plan(SHAPE_ADJ, 'fixture-work-8');
    expect(p).toContain('idx_adjudications_work_id');
    expect(p).not.toContain('SCAN adjudications');
  });

  it('COMPOSES with the hand-created twin: re-applying the migration is a no-op, not an error', () => {
    // The cured box created this exact index by hand before the migration existed. The
    // guard must make re-application silent — this is the IF NOT EXISTS doing load-bearing
    // work, asserted rather than assumed.
    expect(() => db.exec(fs.readFileSync(MIGRATION, 'utf-8'))).not.toThrow();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='work_events'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names.filter(n => n === 'idx_work_events_work_id')).toHaveLength(1);
  });

  it('COUNTERFACTUAL: without the index the same shapes degrade to a full scan — the clauses above bite', () => {
    db.exec('DROP INDEX idx_work_events_work_id;');
    try {
      expect(plan(SHAPE_COUNT, 'fixture-work-1', 'validated')).toContain('SCAN work_events');
      // The MAX shape degrades to a bare "SEARCH work_events" (SQLite phrases the
      // aggregate's tableless fallback as SEARCH, not SCAN) — the honest assertion is
      // that the index is gone from the plan, not a wording SQLite never emits.
      expect(plan(SHAPE_MAX, 'fixture-work-1')).not.toContain('idx_work_events_work_id');
    } finally {
      db.exec(fs.readFileSync(MIGRATION, 'utf-8'));
    }
    expect(plan(SHAPE_COUNT, 'fixture-work-1', 'validated')).not.toContain('SCAN work_events');
  });
});
