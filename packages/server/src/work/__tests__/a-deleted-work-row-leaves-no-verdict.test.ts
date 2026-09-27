// ════════════════════════════════════════════════════════════════════════════════════════
// DELETING A WORK ROW TAKES ITS VERDICT WITH IT (sweep-review-A L1-F1 + L1-F2).
//
// ── THE DEFECT ──
// FOUR things reference `work(id)`, all `NO ACTION`: `work_events.work_id`,
// `adjudications.work_id`, `techniques.build_project_id` and `work.parent_id` (itself). The two
// occurrence delete paths in `work/occurrences.ts` swept `work_events` and forgot
// `adjudications`:
//
//   releaseOccurrence()   — the scheduler could not claim the occurrence, so the row is deleted
//                           and its sequence freed
//   deleteOccurrencesOf() — a schedule is deleted, so its occurrence children go with it
//
// An occurrence CAN carry an adjudication, and nothing guards against it: `store.ts`'s
// `transition()` writes one for any row closed with an authoritative claim or by a system
// closer, with NO `kind` check, and `settleOccurrence()` closes occurrences as `scheduler`.
// So a run that completed and was blessed left a verdict behind pointing at nothing.
//
// MEASURED: one such orphan appeared on the owner's body about an hour AFTER migrations 172 and
// 173 swept the older damage — which is what makes this a live tap rather than history, and is
// why the fix is at the two call sites and not only in a migration.
//
// ── L1-F2: THE WORK-SIDE CENSUS ──
// The agents-side census (`gateway/routes/__tests__/a-purge-leaves-no-orphan-row.test.ts`) asks
// the schema which tables reference `agents` and requires a purged agent be named by none of
// them. The work spine had no such clause, which is the asymmetry that let this one through. The
// last describe block closes it: it reads `work`'s referents from the DATABASE and requires that
// a deleted work row is named by none of them — so a FIFTH reference added later, or a new
// delete path that forgets one, fails without anybody editing this file.
//
// The schema comes from `runMigrations()` rather than `work-fixture.ts`'s hand-built tables: a
// census read off a fixture proves the fixture, and the fixture declares its own FKs.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-work-verdict-sweep');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-work-verdict-sweep', 'dojo.db'),
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
import { releaseOccurrence, deleteOccurrencesOf, OCCURRENCE_KIND } from '../occurrences.js';

const db = (): Database.Database => mockDb.current!;
const NOW = 1_790_000_000_000;

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

/** Every table that declares a foreign key into `work`, read from the live schema. */
function tablesReferencingWork(): Array<{ table: string; column: string; onDelete: string }> {
  const tables = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  const out: Array<{ table: string; column: string; onDelete: string }> = [];
  for (const t of tables) {
    const fks = db().prepare(`PRAGMA foreign_key_list("${t}")`).all() as
      Array<{ table: string; from: string; on_delete: string }>;
    for (const fk of fks) {
      if (fk.table === 'work') out.push({ table: t, column: fk.from, onDelete: fk.on_delete });
    }
  }
  return out;
}

const seedAgentAndModel = (): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))
  `).run();
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))
  `).run();
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES ('a1','a1','m1','idle','{}',1,'owner',datetime('now'),datetime('now'))
  `).run();
};

/** A schedule row (the parent) with the columns `135` makes NOT NULL. */
const seedSchedule = (id: string): void => {
  db().prepare(`
    INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, updated_at,
                      schedule_json, next_run_at, sequence)
    VALUES (?, 'task', 'a1', 'schedule', 'legacy', 'legacy', 'on_deck', 'FYI', 0, 0,
            'a recurring chore', ?, ?, '{"every":"day"}', ?, 0)
  `).run(id, NOW, NOW, NOW + 86_400_000);
};

/** One occurrence child of `parent`, with an event AND an adjudication — the defect's shape. */
const seedOccurrence = (id: string, parent: string, sequence: number): void => {
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, opened_at, updated_at, sequence)
    VALUES (?, ?, ?, 'a1', 'schedule', 'legacy', 'legacy', 'claimed', 'FYI', 0, 0, ?, ?, ?)
  `).run(id, OCCURRENCE_KIND, parent, NOW, NOW, sequence);
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'scheduler', ?)`).run(id, NOW);
  // What `transition()` writes when the scheduler closes this occurrence authoritatively.
  db().prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
                VALUES (?, 'done', 'upheld', 'scheduler', ?)`).run(id, NOW);
};

const verdicts = (workId: string): number =>
  n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', workId);

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  db().pragma('foreign_keys = ON');
  expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
  seedAgentAndModel();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── THE TWO OCCURRENCE DELETE PATHS ──────────────────────────────────────────────────────

describe('releaseOccurrence — the released row takes its verdict with it', () => {
  it('⚠ deletes the occurrence’s adjudication, not only its events', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);
    expect(verdicts('occ-1')).toBe(1);

    releaseOccurrence('occ-1', 'sched-1', NOW, null, 'no agent available');

    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'occ-1')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'occ-1')).toBe(0);
    expect(verdicts('occ-1')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('NEGATIVE CONTROL — another row’s verdict is untouched', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);
    // A verdict on the SCHEDULE itself, which is not being deleted.
    db().prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
                  VALUES ('sched-1', 'done', 'upheld', 'owner', ?)`).run(NOW);

    releaseOccurrence('occ-1', 'sched-1', NOW, null, 'no agent available');

    expect(verdicts('sched-1')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'sched-1')).toBe(1);
  });
});

describe('deleteOccurrencesOf — a schedule’s children take their verdicts with them', () => {
  it('⚠ deletes every child occurrence’s adjudication', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);
    seedOccurrence('occ-2', 'sched-1', 2);
    expect(verdicts('occ-1') + verdicts('occ-2')).toBe(2);

    const removed = deleteOccurrencesOf(['sched-1']);

    expect(removed).toBe(2);
    expect(verdicts('occ-1')).toBe(0);
    expect(verdicts('occ-2')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('NEGATIVE CONTROL — another schedule’s occurrence keeps its verdict', () => {
    seedSchedule('sched-1');
    seedSchedule('sched-2');
    seedOccurrence('occ-1', 'sched-1', 1);
    seedOccurrence('occ-keep', 'sched-2', 1);

    deleteOccurrencesOf(['sched-1']);

    expect(verdicts('occ-1')).toBe(0);
    expect(verdicts('occ-keep')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work WHERE id = ?', 'occ-keep')).toBe(1);
  });

  it('an empty id list is a no-op, not a table sweep', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);

    expect(deleteOccurrencesOf([])).toBe(0);

    expect(verdicts('occ-1')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work')).toBe(2);
  });
});

// ── L1-F2: THE WORK-SIDE CENSUS ──────────────────────────────────────────────────────────

describe('the work-side census — no reference to a deleted work row is forgotten', () => {
  it('names the four references the schema declares today, so a fifth is visible', () => {
    const refs = tablesReferencingWork();
    expect(refs.map(r => `${r.table}.${r.column}`).sort()).toEqual([
      'adjudications.work_id',
      'techniques.build_project_id',
      'work.parent_id',
      'work_events.work_id',
    ]);
    // Non-vacuity: an empty census would pass every clause below it.
    expect(refs.length).toBe(4);
    // All four are NO ACTION — which is WHY every delete path has to sweep them by hand.
    for (const r of refs) expect(r.onDelete, `${r.table}.${r.column}`).toBe('NO ACTION');
  });

  it('⚠ after releaseOccurrence, NOT ONE of them names the deleted row', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);

    releaseOccurrence('occ-1', 'sched-1', NOW, null, 'no agent available');

    for (const { table, column } of tablesReferencingWork()) {
      expect(n(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, 'occ-1'),
        `${table}.${column} still names the released occurrence`).toBe(0);
    }
  });

  it('⚠ after deleteOccurrencesOf, NOT ONE of them names a deleted child', () => {
    seedSchedule('sched-1');
    seedOccurrence('occ-1', 'sched-1', 1);
    seedOccurrence('occ-2', 'sched-1', 2);
    // A technique built by one of the doomed rows — the reference nobody thinks about.
    db().prepare(`
      INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
      VALUES ('t-1', 'A technique', 'published', '/tmp/t-1', 'occ-1', datetime('now'), datetime('now'))
    `).run();

    deleteOccurrencesOf(['sched-1']);

    for (const id of ['occ-1', 'occ-2']) {
      for (const { table, column } of tablesReferencingWork()) {
        expect(n(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, id),
          `${table}.${column} still names ${id}`).toBe(0);
      }
    }
    // …and the technique SURVIVED, with only its link cleared. It outlives its builder.
    expect(n('SELECT COUNT(*) AS n FROM techniques WHERE id = ?', 't-1')).toBe(1);
  });
});
