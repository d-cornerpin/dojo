// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 172 (orphaned work rows) — THE REHEARSAL ON A LIVED-IN BODY.
//
// This is the DESTRUCTIVE half of the wave, and the only migration here that deletes a row. The
// update-integrity standard is binding: an update never fails, and a migration that damages a
// body that has been in use for months is the `.23` / `135` incident class. A delete keyed on a
// LEFT JOIN is exactly the shape that over-reaches when the predicate is subtly wrong — one
// missing `IS NULL`, one inner join, and it takes the live rows too — so the clauses that matter
// most here are the SURVIVORS.
//
// BODY A  a fresh install        — applies against empty tables, deletes nothing, chain completes
// BODY B  a LIVED-IN body        — the orphans go; every row belonging to a LIVE agent stays,
//                                  byte-for-byte, in every state including `on_deck`
// BODY C  RE-RUN                 — idempotent by its PREDICATE, not by the `_migrations` marker
// BODY D  THE REFERENCES         — no dangling reference survives: `PRAGMA foreign_key_check` is
//                                  clean with FKs back ON, parents and children both go, and a
//                                  technique is NULLED rather than deleted
// NEGATIVE CONTROL               — a body with NO orphans at all is left completely alone
// COUNTERFACTUAL                 — the `a.id IS NULL` predicate is load-bearing: with it removed
//                                  the same body loses its LIVE rows, which is the accident this
//                                  file's shape is chosen to avoid
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-172');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-172', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_172 = '172_orphaned_work_rows.sql';

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', MIGRATION_172), 'utf-8',
);

const db = (): Database.Database => mockDb.current!;

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(sql: string = MIGRATION_SQL): void {
  db().pragma('foreign_keys = OFF');
  db().transaction(() => db().exec(sql))();
  db().pragma('foreign_keys = ON');
}

/** Put a fully-migrated body back into the state a v3.2.0 box carries. */
const rewindTo171 = (): void => {
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_172);
};

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const allWorkIds = (): string[] =>
  (db().prepare('SELECT id FROM work ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);

const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

const seedProvider = (): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local', 'openai-compatible', 'http://127.0.0.1:1/v1', 'none', 1,
            datetime('now'), datetime('now'))
  `).run();
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1', 'local', 'M', 'm', '["text"]', 8192, 1024, 1, datetime('now'), datetime('now'))
  `).run();
};

const seedAgent = (id: string): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))
  `).run(id, id);
};

const seedWork = (p: {
  id: string; agentId: string; kind?: string; state?: string; parentId?: string | null; sched?: boolean;
}): void => {
  const now = 1_780_000_000_000;
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state,
                      intent, wakes, closes_thread, title, opened_at, updated_at,
                      schedule_json, next_run_at, closed_at, result_delivery_id)
    VALUES (?, ?, ?, ?, 'owner', 'legacy', 'legacy', ?, 'FYI', 0, 0, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    p.id, p.kind ?? 'task', p.parentId ?? null, p.agentId, p.state ?? 'open',
    `title ${p.id}`, now, now,
    p.sched ? '{"every":"day"}' : null, p.sched ? now + 86_400_000 : null,
  );
  db().prepare(`
    INSERT INTO work_events (work_id, kind, payload, actor, created_at)
    VALUES (?, 'opened', '{}', 'owner', ?)
  `).run(p.id, now);
};

/**
 * A body that has been in use: one live agent with work in four states, and the wreckage of two
 * agents that were purged before the door learned to sweep — including a parent/child pair, an
 * adjudication, a technique built by a vanished agent's project, and an `on_deck` timer.
 */
const fillLivedIn = (): void => {
  seedProvider();
  seedAgent('kevin');
  seedWork({ id: 'live-open', agentId: 'kevin' });
  seedWork({ id: 'live-deck', agentId: 'kevin', state: 'on_deck', sched: true });
  seedWork({ id: 'live-paused', agentId: 'kevin', state: 'paused' });
  seedWork({ id: 'live-proj', agentId: 'kevin', kind: 'project' });
  seedWork({ id: 'live-child', agentId: 'kevin', parentId: 'live-proj' });

  // `ghost-a` and `ghost-b` are NOT inserted into `agents` — that is the whole fixture.
  seedWork({ id: 'orphan-proj', agentId: 'ghost-a', kind: 'project' });
  seedWork({ id: 'orphan-child', agentId: 'ghost-a', parentId: 'orphan-proj' });
  seedWork({ id: 'orphan-deck', agentId: 'ghost-a', state: 'on_deck', sched: true });
  seedWork({ id: 'orphan-claimed', agentId: 'ghost-b', state: 'claimed' });

  db().prepare(`
    INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
    VALUES ('orphan-claimed', 'requests-validation', 'upheld', 'ghost-b', 1780000000000)
  `).run();
  db().prepare(`
    INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
    VALUES ('t-kept', 'Built by a ghost', 'published', '/tmp/techniques/t-kept', 'orphan-proj',
            datetime('now'), datetime('now'))
  `).run();
};

const LIVE_IDS = ['live-child', 'live-deck', 'live-open', 'live-paused', 'live-proj'];

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  db().pragma('foreign_keys = ON');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── BODY A ───────────────────────────────────────────────────────────────────────────────

describe('BODY A — a fresh install', () => {
  it('applies against empty tables and deletes nothing', async () => {
    // `runMigrations` in beforeEach already applied it once, on an empty body.
    expect(n('SELECT COUNT(*) AS n FROM work')).toBe(0);
    expect(
      db().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(MIGRATION_172),
    ).toBeDefined();
    expect(fkViolations()).toEqual([]);
  });
});

// ── BODY B ───────────────────────────────────────────────────────────────────────────────

describe('BODY B — a lived-in body: the orphans go, the live rows stay', () => {
  it('removes exactly the four orphans and keeps all five live rows', () => {
    fillLivedIn();
    rewindTo171();
    expect(allWorkIds()).toHaveLength(9);

    const liveBefore = db().prepare(
      "SELECT * FROM work WHERE agent_id = 'kevin' ORDER BY id",
    ).all();

    apply();

    expect(allWorkIds()).toEqual(LIVE_IDS);
    // Not just the ids — an orphan sweep must not rewrite a surviving row's values.
    expect(db().prepare("SELECT * FROM work WHERE agent_id = 'kevin' ORDER BY id").all())
      .toEqual(liveBefore);
  });

  it('keeps the LIVE `on_deck` timer, which is the state the scheduler polls', () => {
    fillLivedIn();
    rewindTo171();
    apply();

    const deck = db().prepare(
      "SELECT id, agent_id, next_run_at FROM work WHERE state = 'on_deck'",
    ).all() as Array<{ id: string; agent_id: string; next_run_at: number }>;
    expect(deck).toHaveLength(1);
    expect(deck[0].id).toBe('live-deck');
    expect(deck[0].next_run_at).toBeGreaterThan(0);
  });

  it('takes the orphans’ events and adjudications with them, and no others', () => {
    fillLivedIn();
    rewindTo171();
    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(9);
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(1);

    apply();

    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(5);
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM work_events WHERE work_id LIKE 'orphan-%'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM work_events WHERE work_id LIKE 'live-%'")).toBe(5);
  });

  it('touches nothing outside the spine', () => {
    fillLivedIn();
    rewindTo171();
    const agents = db().prepare('SELECT * FROM agents ORDER BY id').all();
    const models = db().prepare('SELECT * FROM models ORDER BY id').all();

    apply();

    expect(db().prepare('SELECT * FROM agents ORDER BY id').all()).toEqual(agents);
    expect(db().prepare('SELECT * FROM models ORDER BY id').all()).toEqual(models);
  });
});

// ── BODY C ───────────────────────────────────────────────────────────────────────────────

describe('BODY C — re-running changes nothing', () => {
  it('is idempotent by its PREDICATE, with the marker deleted between runs', () => {
    fillLivedIn();
    rewindTo171();

    apply();
    const after1 = db().prepare('SELECT * FROM work ORDER BY id').all();
    const events1 = db().prepare('SELECT * FROM work_events ORDER BY id').all();

    apply();
    apply();

    expect(db().prepare('SELECT * FROM work ORDER BY id').all()).toEqual(after1);
    expect(db().prepare('SELECT * FROM work_events ORDER BY id').all()).toEqual(events1);
  });

  it('a second BOOT of the whole chain is also a no-op', async () => {
    fillLivedIn();
    rewindTo171();
    await runMigrations();
    const after1 = allWorkIds();
    await runMigrations();
    expect(allWorkIds()).toEqual(after1);
    expect(after1).toEqual(LIVE_IDS);
  });
});

// ── BODY D ───────────────────────────────────────────────────────────────────────────────

describe('BODY D — no dangling reference survives', () => {
  it('leaves `foreign_key_check` clean with FKs back ON', () => {
    fillLivedIn();
    rewindTo171();
    apply();
    expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
    expect(fkViolations()).toEqual([]);
  });

  it('an orphan PARENT and its orphan CHILD both go', () => {
    fillLivedIn();
    rewindTo171();
    apply();
    expect(n('SELECT COUNT(*) AS n FROM work WHERE id IN (?, ?)', 'orphan-proj', 'orphan-child')).toBe(0);
    // …and no surviving row still names either of them.
    expect(n('SELECT COUNT(*) AS n FROM work WHERE parent_id IN (?, ?)', 'orphan-proj', 'orphan-child')).toBe(0);
  });

  it('a TECHNIQUE built by a vanished agent SURVIVES, with its project nulled', () => {
    fillLivedIn();
    rewindTo171();
    apply();

    const tech = db().prepare('SELECT id, name, build_project_id FROM techniques WHERE id = ?')
      .get('t-kept') as { id: string; name: string; build_project_id: string | null } | undefined;
    expect(tech).toBeDefined();
    expect(tech?.name).toBe('Built by a ghost');
    expect(tech?.build_project_id).toBeNull();
  });

  it('a LIVE row pointing at an orphan parent keeps its own identity, losing only the link', () => {
    // The cross-agent case the schema permits even though the owner's body has none: a live
    // agent's row whose parent belonged to a purged agent. It must SURVIVE.
    fillLivedIn();
    seedWork({ id: 'live-crossling', agentId: 'kevin', parentId: 'orphan-proj' });
    rewindTo171();

    apply();

    const row = db().prepare('SELECT id, agent_id, parent_id FROM work WHERE id = ?')
      .get('live-crossling') as { id: string; agent_id: string; parent_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.agent_id).toBe('kevin');
    expect(row?.parent_id).toBeNull();
    expect(fkViolations()).toEqual([]);
  });
});

// ── NEGATIVE CONTROL ─────────────────────────────────────────────────────────────────────

describe('NEGATIVE CONTROL — a body with no orphans is untouched', () => {
  it('changes not one row', () => {
    seedProvider();
    seedAgent('kevin');
    seedWork({ id: 'live-open', agentId: 'kevin' });
    seedWork({ id: 'live-deck', agentId: 'kevin', state: 'on_deck', sched: true });
    rewindTo171();

    const work = db().prepare('SELECT * FROM work ORDER BY id').all();
    const events = db().prepare('SELECT * FROM work_events ORDER BY id').all();

    apply();

    expect(db().prepare('SELECT * FROM work ORDER BY id').all()).toEqual(work);
    expect(db().prepare('SELECT * FROM work_events ORDER BY id').all()).toEqual(events);
  });
});

// ── COUNTERFACTUAL ───────────────────────────────────────────────────────────────────────

describe('COUNTERFACTUAL — the `a.id IS NULL` predicate is load-bearing', () => {
  it('without it the SAME body loses its live rows, which is the accident being avoided', () => {
    fillLivedIn();
    rewindTo171();

    // Drop the one clause that distinguishes an orphan from a row. Nothing else changes.
    const unguarded = MIGRATION_SQL.replace(/WHERE a\.id IS NULL/g, 'WHERE 1');
    expect(unguarded).not.toBe(MIGRATION_SQL);

    apply(unguarded);

    // Every work row is gone — the live ones too. This is what the real predicate prevents,
    // and asserting it is how we know the guard is not decoration.
    expect(allWorkIds()).toEqual([]);
  });
});
