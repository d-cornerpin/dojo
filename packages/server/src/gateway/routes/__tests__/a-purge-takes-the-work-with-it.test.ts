// ════════════════════════════════════════════════════════════════════════════════════════
// PURGING AN AGENT TAKES ITS WORK WITH IT (BACKLOG WAVE-1A).
//
// ── THE DEFECT ──
// `POST /api/agents/:id/purge` sweeps seven tables by hand — messages, the agent bus, summaries
// and their two link tables, context items, large files, audit log — and walked straight past the
// work spine. `work.agent_id` carries no foreign key and no cascade, deliberately (migration 135,
// PART 0 rider 1: a work row stays readable after its agent is gone), so NOTHING deleted those
// rows: not the door, and not the database. Every purge on every box left the agent's work behind.
//
// The sharp end is `on_deck`. That is the state `scheduler/runner.ts`'s 30-second poll selects on,
// so an orphan in it is a timer still armed for an agent that cannot run — and the two such rows
// the backlog entry reported had, by the time this was worked, already been FIRED or abandoned
// rather than sitting stuck. That is why the clauses below seed a scheduled row specifically AND
// why the sweep is not restricted to that state.
//
// ── WHAT THESE CLAUSES ARE FOR ──
// The delete is easy; the ORDER is not. Four things reference `work(id)`, all `NO ACTION` —
// `work_events.work_id`, `adjudications.work_id`, `techniques.build_project_id`, and
// `work.parent_id` referencing its own table. The server runs with `foreign_keys = ON`, so a
// naive `DELETE FROM work WHERE agent_id = ?` FAILS the moment the agent owns a parent and its
// child, and a sweep that forgets `techniques` either fails or strands a dangling reference. So
// the real assertions here are the SURVIVORS and `PRAGMA foreign_key_check`, not the row count.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../logger.js', () => {
  const noop = (): void => {};
  return {
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    setLogLevel: noop, setLogBroadcast: noop, readLogEntries: () => [],
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-purge-work', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

// The purge door's only gate is "not the primary, and terminated". Nothing in this file is the
// primary, and saying so here keeps the clauses from depending on a config row.
vi.mock('../../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  getPrimaryAgentId: () => 'primary-not-under-test',
  getHealerAgentId: () => null,
  getDreamerAgentId: () => null,
  getImaginerAgentId: () => null,
  isTrainerAgent: () => false,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';

const db = (): Database.Database => mockDb.current!;

const purge = (id: string): Promise<Response> =>
  agentsRouter.request(`/${id}/purge`, { method: 'POST' });

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const workIds = (agentId: string): string[] =>
  (db().prepare('SELECT id FROM work WHERE agent_id = ? ORDER BY id').all(agentId) as Array<{ id: string }>)
    .map(r => r.id);

/** Rows that violate a declared foreign key. Must always be empty. */
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

const seedAgent = (id: string, status = 'terminated'): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, 'm1', ?, '{}', 1, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, status);
};

/**
 * One work row, with the columns `135_work_spine.sql` makes NOT NULL. `sched` turns it into the
 * schedulable shape the defect was reported against: state `on_deck` with a future `next_run_at`.
 */
const seedWork = (p: {
  id: string; agentId: string; kind?: string; state?: string; parentId?: string | null; sched?: boolean;
}): string => {
  const now = Date.now();
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, root_kind, root_id, state,
                      intent, wakes, closes_thread, title, opened_at, updated_at,
                      schedule_json, next_run_at)
    VALUES (?, ?, ?, ?, 'owner', 'legacy', 'legacy', ?, 'FYI', 0, 0, ?, ?, ?, ?, ?)
  `).run(
    p.id, p.kind ?? 'task', p.parentId ?? null, p.agentId, p.state ?? 'open',
    `title ${p.id}`, now, now,
    p.sched ? '{"every":"day"}' : null, p.sched ? now + 86_400_000 : null,
  );
  db().prepare(`
    INSERT INTO work_events (work_id, kind, payload, actor, created_at)
    VALUES (?, 'opened', '{}', 'owner', ?)
  `).run(p.id, now);
  return p.id;
};

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  // The server runs with FKs ON; the migration chain turns them off and back on. Assert the
  // state these clauses depend on rather than assuming the chain restored it.
  db().pragma('foreign_keys = ON');
  expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
  seedProvider();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the purge door sweeps the work spine', () => {
  it('a terminated agent with a SCHEDULED work row loses it', async () => {
    seedAgent('doomed');
    seedWork({ id: 'w-sched', agentId: 'doomed', state: 'on_deck', sched: true });

    expect(workIds('doomed')).toEqual(['w-sched']);
    expect(n("SELECT COUNT(*) AS n FROM work WHERE state = 'on_deck'")).toBe(1);

    const res = await purge('doomed');
    expect(res.status).toBe(200);

    expect(workIds('doomed')).toEqual([]);
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'doomed')).toBe(0);
    // The state the scheduler polls is empty, which is the user-visible half.
    expect(n("SELECT COUNT(*) AS n FROM work WHERE state = 'on_deck'")).toBe(0);
    // And the events went with the row rather than becoming orphans of their own.
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-sched')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('⚠ a PARENT and its CHILD both go, which a naive delete cannot do', async () => {
    // `work.parent_id REFERENCES work(id)` is immediate and has no cascade, so with FKs ON a
    // single `DELETE FROM work WHERE agent_id = ?` trips over its own rows. This is the clause
    // that fails if the nulling step is dropped.
    seedAgent('doomed');
    seedWork({ id: 'w-parent', agentId: 'doomed', kind: 'project' });
    seedWork({ id: 'w-child', agentId: 'doomed', parentId: 'w-parent' });
    seedWork({ id: 'w-grandchild', agentId: 'doomed', parentId: 'w-child' });

    const res = await purge('doomed');
    expect(res.status).toBe(200);

    expect(workIds('doomed')).toEqual([]);
    expect(n('SELECT COUNT(*) AS n FROM work')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('adjudication rows on the doomed work go too', async () => {
    seedAgent('doomed');
    seedWork({ id: 'w-claim', agentId: 'doomed', state: 'claimed' });
    db().prepare(`
      INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
      VALUES ('w-claim', 'requests-validation', 'upheld', 'someone', ?)
    `).run(Date.now());

    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(1);
    expect((await purge('doomed')).status).toBe(200);
    expect(n('SELECT COUNT(*) AS n FROM adjudications')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('a TECHNIQUE outlives the project that built it — nulled, never deleted', async () => {
    seedAgent('doomed');
    seedWork({ id: 'w-proj', agentId: 'doomed', kind: 'project' });
    db().prepare(`
      INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
      VALUES ('t-1', 'A technique', 'published', '/tmp/techniques/t-1', 'w-proj',
              datetime('now'), datetime('now'))
    `).run();

    expect((await purge('doomed')).status).toBe(200);

    const tech = db().prepare('SELECT id, build_project_id FROM techniques WHERE id = ?').get('t-1') as
      { id: string; build_project_id: string | null } | undefined;
    expect(tech).toBeDefined();
    expect(tech?.build_project_id).toBeNull();
    expect(fkViolations()).toEqual([]);
  });

  it('NEGATIVE CONTROL — another agent keeps every one of its rows', async () => {
    seedAgent('doomed');
    seedAgent('keeper', 'idle');
    seedWork({ id: 'w-doomed', agentId: 'doomed', state: 'on_deck', sched: true });
    seedWork({ id: 'w-keeper-1', agentId: 'keeper', state: 'on_deck', sched: true });
    seedWork({ id: 'w-keeper-2', agentId: 'keeper' });

    expect((await purge('doomed')).status).toBe(200);

    expect(workIds('keeper')).toEqual(['w-keeper-1', 'w-keeper-2']);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id LIKE ?', 'w-keeper-%')).toBe(2);
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'keeper')).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM work WHERE state = 'on_deck'")).toBe(1);
  });

  it('NEGATIVE CONTROL — the gates still hold: a LIVE agent is refused and keeps its work', async () => {
    seedAgent('alive', 'idle');
    seedWork({ id: 'w-alive', agentId: 'alive', state: 'on_deck', sched: true });

    const res = await purge('alive');
    expect(res.status).toBe(400);
    // A refused purge must not have swept anything on its way to the refusal.
    expect(workIds('alive')).toEqual(['w-alive']);
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'alive')).toBe(1);
  });

  it('purging an agent with no work at all is a clean no-op on the spine', async () => {
    seedAgent('empty');
    seedAgent('keeper', 'idle');
    seedWork({ id: 'w-keeper', agentId: 'keeper' });

    expect((await purge('empty')).status).toBe(200);

    expect(workIds('keeper')).toEqual(['w-keeper']);
    expect(fkViolations()).toEqual([]);
  });
});
