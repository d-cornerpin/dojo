// v3.5 DONE IS MEASURED, Task A1 — MIGRATION 200: a task can carry a measure, and the engine keeps its ledger.
//
// The schema comes from the REAL migration chain (never a hand-rolled fixture). The second case
// rebuilds a body as it stood BEFORE 200 (the chain minus 200), plants a lived-in task row, and
// re-runs the runner with 200 pending: the old row must read as "no measure", the ledger must
// start empty, and a re-touch of the same item must be one row (the primary key is the count).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-migration-200-test', 'dojo.db'),
  };
});

import { runMigrations } from '../migrations.js';

const FILE = '200_work_measure_and_ledger.sql';
const MEASURE_COLS = ['measure_json', 'measure_initial', 'measure_remaining', 'measure_at'];

function workCols(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(work)').all() as Array<{ name: string }>).map((c) => c.name);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

describe('migration 200: measure + ledger', () => {
  it('adds the four measure columns and the ledger table keyed by (work_id, item_key)', () => {
    const db = mockDb.current!;
    expect(workCols(db)).toEqual(expect.arrayContaining(MEASURE_COLS));
    const ledger = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_ledger'").get();
    expect(ledger).toBeTruthy();
    const pk = (db.prepare('PRAGMA table_info(work_ledger)').all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(['work_id', 'item_key']);
    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?').get(FILE)).toBeTruthy();
  });

  it('a body from before 200 applies it: an old row reads as unmeasured and the ledger starts empty', () => {
    const db = mockDb.current!;
    // Rewind this body to "200 never ran".
    db.exec('DROP TABLE work_ledger');
    for (const c of MEASURE_COLS) db.exec(`ALTER TABLE work DROP COLUMN ${c}`);
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
    expect(workCols(db)).not.toEqual(expect.arrayContaining(['measure_json']));
    // The row shape work-spine-schema.test.ts seeds: every NOT NULL column of the spine, nothing more.
    const row: Record<string, unknown> = {
      id: 'w-old', kind: 'task', agent_id: 'agent-a', requester: 'agent', requester_id: 'agent-a',
      root_kind: 'tracker', root_id: 'r1', state: 'claimed', intent: 'tracker', wakes: 0, closes_thread: 0,
      hop_count: 0, compile_pending: 0, attempts: 0, opened_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
      provenance: 'live', title: 'old task',
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);

    runMigrations();

    const r = db.prepare('SELECT measure_json, measure_initial, measure_remaining, measure_at FROM work WHERE id = ?').get('w-old') as Record<string, unknown>;
    expect(r).toEqual({ measure_json: null, measure_initial: null, measure_remaining: null, measure_at: null });
    expect((db.prepare('SELECT COUNT(*) AS n FROM work_ledger').get() as { n: number }).n).toBe(0);

    // A re-touch of the same item is the same row: COUNT(*) is "distinct items touched".
    const ins = db.prepare(
      `INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(work_id, item_key) DO UPDATE SET last_at = excluded.last_at`,
    );
    ins.run('w-old', 'gmail:msg:a', 'gmail_label', 1, 1);
    ins.run('w-old', 'gmail:msg:a', 'gmail_label', 2, 2);
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(last_at) AS last FROM work_ledger WHERE work_id = ?').get('w-old')).toEqual({ n: 1, last: 2 });

    // A second boot does not re-run it.
    expect(() => runMigrations()).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(FILE) as { n: number }).n).toBe(1);
  });
});

// ── 200b: `measured` joins the declared work_events kinds (a CHECK rebuild, 189's shape) ──

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const FILE_B = '200b_work_event_kind_measured.sql';

describe('migration 200b: the measured event kind', () => {
  const insertEvent = (db: Database.Database, kind: string, id?: number): void => {
    db.prepare(`INSERT INTO work_events (${id ? 'id, ' : ''}work_id, kind, payload, actor, created_at) VALUES (${id ? '?, ' : ''}'w-ev', ?, '{}', 'engine', 1)`)
      .run(...(id ? [id, kind] : [kind]));
  };
  const seedWorkRow = (db: Database.Database): void => {
    const row: Record<string, unknown> = {
      id: 'w-ev', kind: 'task', agent_id: 'agent-a', requester: 'agent', requester_id: 'agent-a',
      root_kind: 'tracker', root_id: 'r1', state: 'claimed', intent: 'tracker', wakes: 0, closes_thread: 0,
      hop_count: 0, compile_pending: 0, attempts: 0, opened_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, provenance: 'live',
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
  };

  it('a body as 189 left it applies 200b: every event, the id counter, the index, and the verdict trigger survive', () => {
    const db = mockDb.current!;
    seedWorkRow(db);
    // Rewind to "200b never ran": the table exactly as 189 built it (its own file, re-run).
    db.exec(fs.readFileSync(path.join(MIGRATIONS, '189_work_told_event.sql'), 'utf-8'));
    db.prepare('DELETE FROM _migrations WHERE name = ?').run(FILE_B);
    expect(() => insertEvent(db, 'measured')).toThrow(/CHECK constraint failed/);
    insertEvent(db, 'opened', 5);
    insertEvent(db, 'person_told', 9);
    insertEvent(db, 'transition', 12);
    db.prepare('DELETE FROM work_events WHERE id = 12').run();   // the counter now runs ahead of MAX(id)
    const seqBefore = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'work_events'").get() as { seq: number }).seq;
    expect(seqBefore).toBe(12);

    runMigrations();

    expect(db.prepare('SELECT id, kind FROM work_events ORDER BY id').all()).toEqual([{ id: 5, kind: 'opened' }, { id: 9, kind: 'person_told' }]);
    expect((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'work_events'").get() as { seq: number }).seq).toBe(12);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_events_work_id'").get()).toBeTruthy();
    insertEvent(db, 'measured');
    expect(db.prepare("SELECT id FROM work_events WHERE kind = 'measured'").get()).toEqual({ id: 13 });   // never a reused id
    expect(() => insertEvent(db, 'not_a_kind')).toThrow(/CHECK constraint failed/);
    // 189c's trigger still stamps a new verdict with the id the next event receives.
    db.prepare("INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at) VALUES ('w-ev', 'done', 'upheld', 'pm', 1)").run();
    expect(db.prepare("SELECT event_seq FROM adjudications WHERE work_id = 'w-ev'").get()).toEqual({ event_seq: 14 });
  });

  it('fix round 1 (ruling): the ONE rebuild of the release also carries D1\'s `continued` and `stalled`', async () => {
    const db = mockDb.current!;
    seedWorkRow(db);
    for (const k of ['measured', 'continued', 'stalled']) expect(() => insertEvent(db, k)).not.toThrow();
    const { WORK_EVENT_KINDS } = await import('../../work/event-kinds.js');
    expect(WORK_EVENT_KINDS).toEqual(expect.arrayContaining(['measured', 'continued', 'stalled']));
    // ONE rebuild for this release; 901 is the next release's one migration (the one path to done).
    const rebuilders = fs.readdirSync(MIGRATIONS).filter((f) => f > '200' && /CHECK\s*\(\s*kind\s+IN/i.test(fs.readFileSync(path.join(MIGRATIONS, f), 'utf-8')));
    expect(rebuilders).toEqual([FILE_B, '901_task_done_one_path.sql']);
  });
});
