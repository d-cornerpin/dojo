// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 175 (orphaned work references) — THE REHEARSAL.
//
// The third orphan sweep, and the only one whose damage was still being PRODUCED when it was
// written: 172 and 173 left the owner's body clean and a new `adjudications -> work` orphan
// appeared about an hour later. So the source fix in `work/occurrences.ts` ships with it, and
// this file guards the repair half only — the tap itself is pinned by
// `work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts`.
//
// BODY A  fresh install   — all four statements apply against empty tables
// BODY B  lived-in body   — the orphans go; every row with a real parent stays
// BODY C  re-run          — idempotent by PREDICATE, with the marker deleted between runs
// BODY D  references      — `foreign_key_check` clean with FKs back ON; a surviving child keeps
//                           its identity and loses only the link
// NEGATIVE CONTROL        — a clean body changes not one row
// COUNTERFACTUAL          — `NOT EXISTS` inverted, the same body loses its LIVE rows
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-175');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-migration-175', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_175 = '176_orphaned_work_references.sql';
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', MIGRATION_175), 'utf-8',
);

const db = (): Database.Database => mockDb.current!;
const NOW = 1_790_000_000_000;

function apply(sql: string = MIGRATION_SQL): void {
  db().pragma('foreign_keys = OFF');
  db().transaction(() => db().exec(sql))();
  db().pragma('foreign_keys = ON');
}

const rewindTo174 = (): void => {
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_175);
};

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

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
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES ('a1','a1','m1','idle','{}',1,'owner',datetime('now'),datetime('now'))
  `).run();
};

const seedWork = (id: string, parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, 'task', ?, 'a1', 'owner', 'legacy', 'legacy', 'open', 'FYI', 0, 0, ?, ?, ?)
  `).run(id, parent, `t ${id}`, NOW, NOW);
};

const seedVerdict = (workId: string): void => {
  db().prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
                VALUES (?, 'done', 'upheld', 'scheduler', ?)`).run(workId, NOW);
};

const seedEvent = (workId: string): void => {
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'owner', ?)`).run(workId, NOW);
};

/**
 * A body carrying the tap's damage. Seeded with `foreign_keys = OFF` because an orphan CANNOT be
 * created with the pragma on — the fixture's provenance is the defect's provenance (a delete that
 * ran without sweeping its referents).
 */
const fillLivedIn = (): void => {
  db().pragma('foreign_keys = OFF');
  seedBase();
  // Live work, with a live verdict and a live event.
  seedWork('w-live');
  seedVerdict('w-live');
  seedEvent('w-live');
  // A live child of live work, and a live technique built by it.
  seedWork('w-child', 'w-live');
  db().prepare(`
    INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
    VALUES ('t-live','Built by live work','published','/tmp/t-live','w-live',datetime('now'),datetime('now'))
  `).run();

  // ── the damage: `w-gone` is NOT in `work` ──
  seedVerdict('w-gone');
  seedEvent('w-gone');
  seedWork('w-stranded', 'w-gone');           // a live child whose parent vanished
  db().prepare(`
    INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
    VALUES ('t-stranded','Built by a ghost','published','/tmp/t-str','w-gone',datetime('now'),datetime('now'))
  `).run();
  db().pragma('foreign_keys = ON');
};

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  db().pragma('foreign_keys = ON');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('BODY A — a fresh install', () => {
  it('applies all four statements against empty tables and deletes nothing', () => {
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(0);
    expect(db().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(MIGRATION_175)).toBeDefined();
    expect(fkViolations()).toEqual([]);
  });
});

describe('BODY B — a lived-in body', () => {
  it('removes the orphaned verdict and keeps the live one', () => {
    fillLivedIn();
    rewindTo174();
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(2);

    apply();

    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'w-gone')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'w-live')).toBe(1);
  });

  it('removes the orphaned event and keeps the live one', () => {
    fillLivedIn();
    rewindTo174();

    apply();

    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-gone')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-live')).toBe(1);
  });

  it('deletes no work row, no agent and no technique', () => {
    fillLivedIn();
    rewindTo174();
    const work = n('SELECT COUNT(*) AS n FROM work');
    const techs = n('SELECT COUNT(*) AS n FROM techniques');

    apply();

    expect(n('SELECT COUNT(*) AS n FROM work')).toBe(work);
    expect(n('SELECT COUNT(*) AS n FROM techniques')).toBe(techs);
    expect(n('SELECT COUNT(*) AS n FROM agents')).toBe(1);
  });
});

describe('BODY C — re-running changes nothing', () => {
  it('is idempotent by its PREDICATES', () => {
    fillLivedIn();
    rewindTo174();
    apply();
    const snap = (): string => JSON.stringify({
      adj: db().prepare('SELECT * FROM adjudications ORDER BY id').all(),
      ev: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      work: db().prepare('SELECT id, parent_id FROM work ORDER BY id').all(),
      tech: db().prepare('SELECT id, build_project_id FROM techniques ORDER BY id').all(),
    });
    const after1 = snap();

    apply();
    apply();

    expect(snap()).toBe(after1);
  });

  it('a second BOOT of the whole chain is also a no-op', async () => {
    fillLivedIn();
    rewindTo174();
    await runMigrations();
    const after1 = n('SELECT COUNT(*) AS n FROM adjudications');
    await runMigrations();
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(after1);
    expect(after1).toBe(1);
  });
});

describe('BODY D — the references', () => {
  it('leaves `foreign_key_check` clean with FKs back ON', () => {
    fillLivedIn();
    rewindTo174();
    expect(fkViolations().length).toBeGreaterThan(0);

    apply();

    expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
    expect(fkViolations()).toEqual([]);
  });

  it('⚠ a stranded child keeps its identity and loses only the link', () => {
    fillLivedIn();
    rewindTo174();

    apply();

    const row = db().prepare('SELECT id, agent_id, parent_id, state FROM work WHERE id = ?')
      .get('w-stranded') as { id: string; agent_id: string; parent_id: string | null; state: string };
    expect(row.agent_id).toBe('a1');
    expect(row.state).toBe('open');
    expect(row.parent_id).toBeNull();
    // …and a LIVE parent link is untouched.
    const live = db().prepare('SELECT parent_id FROM work WHERE id = ?').get('w-child') as
      { parent_id: string | null };
    expect(live.parent_id).toBe('w-live');
  });

  it('⚠ a technique survives its vanished builder, with the link nulled', () => {
    fillLivedIn();
    rewindTo174();

    apply();

    const stranded = db().prepare('SELECT id, name, build_project_id FROM techniques WHERE id = ?')
      .get('t-stranded') as { id: string; name: string; build_project_id: string | null };
    expect(stranded.name).toBe('Built by a ghost');
    expect(stranded.build_project_id).toBeNull();
    // …and the live one keeps its builder.
    const live = db().prepare('SELECT build_project_id FROM techniques WHERE id = ?').get('t-live') as
      { build_project_id: string | null };
    expect(live.build_project_id).toBe('w-live');
  });
});

describe('NEGATIVE CONTROL — a clean body is untouched', () => {
  it('changes not one row', () => {
    seedBase();
    seedWork('w-live');
    seedVerdict('w-live');
    seedEvent('w-live');
    rewindTo174();

    const before = JSON.stringify({
      adj: db().prepare('SELECT * FROM adjudications ORDER BY id').all(),
      ev: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      work: db().prepare('SELECT id, parent_id FROM work ORDER BY id').all(),
    });

    apply();

    expect(JSON.stringify({
      adj: db().prepare('SELECT * FROM adjudications ORDER BY id').all(),
      ev: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      work: db().prepare('SELECT id, parent_id FROM work ORDER BY id').all(),
    })).toBe(before);
  });
});

describe('COUNTERFACTUAL — `NOT EXISTS` is load-bearing', () => {
  it('inverted, the SAME body loses its LIVE rows', () => {
    fillLivedIn();
    rewindTo174();
    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'w-live')).toBe(1);

    const inverted = MIGRATION_SQL.replace(/NOT EXISTS \(SELECT 1 FROM/g, 'EXISTS (SELECT 1 FROM');
    expect(inverted).not.toBe(MIGRATION_SQL);

    apply(inverted);

    // The LIVE verdict and event are what went. This is what the real predicate prevents.
    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'w-live')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ?', 'w-gone')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-live')).toBe(0);
  });
});
