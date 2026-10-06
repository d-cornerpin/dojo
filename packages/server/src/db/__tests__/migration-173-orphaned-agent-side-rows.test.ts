// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 173 (orphaned agent side rows + orphaned work events) — THE REHEARSAL.
//
// The destructive companion to `172`. Ten statements, nine of them `DELETE`, every one keyed on
// a `NOT EXISTS` against a parent table — which is exactly the shape that quietly takes the live
// rows too when the predicate is subtly wrong. So the clauses that matter most here are the
// SURVIVORS and the COUNTERFACTUAL, not the deletion counts.
//
// BODY A  a fresh install        — every statement applies against empty tables, chain completes
// BODY B  a LIVED-IN body        — the orphans go; every row with a real parent stays, byte-for-byte
// BODY C  RE-RUN                 — idempotent by PREDICATE, with the marker deleted between runs
// BODY D  THE REFERENCES         — `foreign_key_check` clean with FKs back ON; a dangling
//                                  `parent_agent` loses the LINK and the child survives
// NEGATIVE CONTROL               — a body with no orphans changes not one row
// COUNTERFACTUAL                 — `NOT EXISTS` is load-bearing: inverted, the same body loses
//                                  its live rows
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-173');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-migration-173', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_173 = '173_orphaned_agent_side_rows.sql';
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', MIGRATION_173), 'utf-8',
);

const db = (): Database.Database => mockDb.current!;

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(sql: string = MIGRATION_SQL): void {
  db().pragma('foreign_keys = OFF');
  db().transaction(() => db().exec(sql))();
  db().pragma('foreign_keys = ON');
}

const rewindTo172 = (): void => {
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_173);
};

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

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

const seedAgent = (id: string, parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, 'm1', 'idle', '{}', 1, ?, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, parent);
};

/** Side rows for `agentId`, which may or may not exist in `agents` — that is the fixture. */
const seedSideRows = (agentId: string, tag: string): void => {
  const d = db();
  d.prepare(`INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
             VALUES (?, ?, 'tool_call', '/tmp/x', 'success', 'ok', datetime('now'))`)
    .run(`audit-${tag}`, agentId);
  d.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, source, manifest_fingerprint)
             VALUES (?, 'fs_read', 'allow', '*', 'manifest', 'fp')`).run(agentId);
  d.prepare(`INSERT INTO drain_state (agent_id, drain, head, stuck, updated_at)
             VALUES (?, 'unserved_wake', '', 0, ?)`).run(agentId, 1_780_000_000_000);
  d.prepare(`INSERT INTO briefings (id, agent_id, content, token_count)
             VALUES (?, ?, 'a briefing', 12)`).run(`brief-${tag}`, agentId);
  d.prepare(`INSERT INTO context_items (agent_id, item_type, item_id, ordinal)
             VALUES (?, 'note', ?, 0)`).run(agentId, `ctx-${tag}`);
  d.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count,
                                    earliest_at, latest_at, created_at)
             VALUES (?, ?, 1, 'condensed', 'sum', 10,
                     datetime('now'), datetime('now'), datetime('now'))`)
    .run(`sum-${tag}`, agentId);
};

const seedWorkWithEvent = (workId: string, agentId: string): void => {
  const now = 1_780_000_000_000;
  db().prepare(`
    INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, 'task', ?, 'owner', 'legacy', 'legacy', 'open', 'FYI', 0, 0, ?, ?, ?)
  `).run(workId, agentId, `t ${workId}`, now, now);
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'owner', ?)`).run(workId, now);
};

const sideRows = (agentId: string): Record<string, number> => ({
  audit_log: n('SELECT COUNT(*) AS n FROM audit_log WHERE agent_id = ?', agentId),
  grant_rule: n('SELECT COUNT(*) AS n FROM grant_rule WHERE agent_id = ?', agentId),
  drain_state: n('SELECT COUNT(*) AS n FROM drain_state WHERE agent_id = ?', agentId),
  briefings: n('SELECT COUNT(*) AS n FROM briefings WHERE agent_id = ?', agentId),
  context_items: n('SELECT COUNT(*) AS n FROM context_items WHERE agent_id = ?', agentId),
  summaries: n('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?', agentId),
});

const ZERO = {
  audit_log: 0, grant_rule: 0, drain_state: 0, briefings: 0, context_items: 0, summaries: 0,
};
const ONE_EACH = {
  audit_log: 1, grant_rule: 1, drain_state: 1, briefings: 1, context_items: 1, summaries: 1,
};

/**
 * A body carrying exactly the damage the kit's FK-off teardown leaves: side rows for agents that
 * are GONE, a dangling `parent_agent`, `work_events` whose `work` row is gone — beside a live
 * agent with a full set of its own rows, and a live work row with its own event.
 */
const fillLivedIn = (): void => {
  // ⚠ SEEDED WITH `foreign_keys = OFF`, and that is not a convenience — it is the PROVENANCE.
  // An orphan row cannot be created while the pragma is on; the database refuses it. These rows
  // exist on real bodies because `dojo-test-kit/behavioral/runner.mjs` tears the battery down
  // through the `sqlite3` CLI, which leaves FKs off, and deletes `agents` without naming the
  // tables that hang off them. A fixture that could be built with the pragma ON would not be
  // reproducing this defect.
  db().pragma('foreign_keys = OFF');
  seedProvider();
  seedAgent('alive');
  seedSideRows('alive', 'alive');
  seedWorkWithEvent('w-alive', 'alive');

  // `ghost-a` / `ghost-b` are NOT in `agents` — that is the fixture.
  seedSideRows('ghost-a', 'ga');
  seedSideRows('ghost-b', 'gb');

  // A live agent whose parent is gone: the row must SURVIVE, the link must not.
  seedAgent('stranded', 'ghost-a');

  // An event whose work row is gone.
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES ('w-vanished', 'opened', '{}', 'owner', ?)`).run(1_780_000_000_000);
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

// ── BODY A ───────────────────────────────────────────────────────────────────────────────

describe('BODY A — a fresh install', () => {
  it('applies every statement against empty tables and deletes nothing', () => {
    expect(n('SELECT COUNT(*) AS n FROM audit_log')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(0);
    expect(db().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(MIGRATION_173)).toBeDefined();
    expect(fkViolations()).toEqual([]);
  });
});

// ── BODY B ───────────────────────────────────────────────────────────────────────────────

describe('BODY B — a lived-in body: the orphans go, everything with a parent stays', () => {
  it('removes the ghosts’ side rows and keeps the live agent’s, one for one', () => {
    fillLivedIn();
    rewindTo172();
    expect(sideRows('ghost-a')).toEqual(ONE_EACH);
    expect(sideRows('ghost-b')).toEqual(ONE_EACH);
    const aliveBefore = sideRows('alive');
    expect(aliveBefore).toEqual(ONE_EACH);

    apply();

    expect(sideRows('ghost-a')).toEqual(ZERO);
    expect(sideRows('ghost-b')).toEqual(ZERO);
    expect(sideRows('alive')).toEqual(aliveBefore);
  });

  it('removes the orphaned work event and keeps the one whose work row exists', () => {
    fillLivedIn();
    rewindTo172();
    expect(n('SELECT COUNT(*) AS n FROM work_events')).toBe(2);

    apply();

    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-vanished')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ?', 'w-alive')).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM work')).toBe(1);   // no work row was touched
  });

  it('touches no agent row and no message row', () => {
    fillLivedIn();
    rewindTo172();
    const agents = db().prepare('SELECT id, name, status FROM agents ORDER BY id').all();
    const messages = n('SELECT COUNT(*) AS n FROM messages');

    apply();

    // `parent_agent` is expected to change on one row, so the comparison excludes it and the
    // dedicated clause in BODY D checks it.
    expect(db().prepare('SELECT id, name, status FROM agents ORDER BY id').all()).toEqual(agents);
    expect(n('SELECT COUNT(*) AS n FROM messages')).toBe(messages);
  });
});

// ── BODY C ───────────────────────────────────────────────────────────────────────────────

describe('BODY C — re-running changes nothing', () => {
  it('is idempotent by its PREDICATES, with the marker deleted between runs', () => {
    fillLivedIn();
    rewindTo172();

    apply();
    const snapshot = (): string => JSON.stringify({
      audit: db().prepare('SELECT * FROM audit_log ORDER BY id').all(),
      grant: db().prepare('SELECT * FROM grant_rule ORDER BY rowid').all(),
      events: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
    });
    const after1 = snapshot();

    apply();
    apply();

    expect(snapshot()).toBe(after1);
  });

  it('a second BOOT of the whole chain is also a no-op', async () => {
    fillLivedIn();
    rewindTo172();
    await runMigrations();
    const after1 = sideRows('alive');
    await runMigrations();
    expect(sideRows('alive')).toEqual(after1);
    expect(sideRows('ghost-a')).toEqual(ZERO);
  });
});

// ── BODY D ───────────────────────────────────────────────────────────────────────────────

describe('BODY D — the references', () => {
  it('leaves `foreign_key_check` clean with FKs back ON', () => {
    fillLivedIn();
    rewindTo172();
    expect(fkViolations().length).toBeGreaterThan(0);   // the fixture really is damaged

    apply();

    expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
    expect(fkViolations()).toEqual([]);
  });

  it('⚠ a dangling `parent_agent` loses the LINK — the child agent SURVIVES', () => {
    fillLivedIn();
    rewindTo172();
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE parent_agent = ?', 'ghost-a')).toBe(1);

    apply();

    const child = db().prepare('SELECT id, status, parent_agent FROM agents WHERE id = ?')
      .get('stranded') as { id: string; status: string; parent_agent: string | null } | undefined;
    expect(child).toBeDefined();
    expect(child?.status).toBe('idle');
    expect(child?.parent_agent).toBeNull();
  });

  it('a LIVE parent link is left exactly as it was', () => {
    fillLivedIn();
    seedAgent('real-child', 'alive');
    rewindTo172();

    apply();

    const kept = db().prepare('SELECT parent_agent FROM agents WHERE id = ?').get('real-child') as
      { parent_agent: string | null };
    expect(kept.parent_agent).toBe('alive');
  });
});

// ── NEGATIVE CONTROL ─────────────────────────────────────────────────────────────────────

describe('NEGATIVE CONTROL — a clean body is untouched', () => {
  it('changes not one row', () => {
    seedProvider();
    seedAgent('alive');
    seedSideRows('alive', 'alive');
    seedWorkWithEvent('w-alive', 'alive');
    rewindTo172();

    const before = JSON.stringify({
      audit: db().prepare('SELECT * FROM audit_log ORDER BY id').all(),
      events: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
    });

    apply();

    expect(JSON.stringify({
      audit: db().prepare('SELECT * FROM audit_log ORDER BY id').all(),
      events: db().prepare('SELECT * FROM work_events ORDER BY id').all(),
      agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
    })).toBe(before);
    expect(fkViolations()).toEqual([]);
  });
});

// ── COUNTERFACTUAL ───────────────────────────────────────────────────────────────────────

describe('COUNTERFACTUAL — the `NOT EXISTS` predicate is load-bearing', () => {
  it('inverted, the SAME body loses its LIVE rows — which is the accident being avoided', () => {
    fillLivedIn();
    rewindTo172();
    expect(sideRows('alive')).toEqual(ONE_EACH);

    // Invert every guard: delete the rows whose parent DOES exist. Nothing else changes.
    const inverted = MIGRATION_SQL.replace(/NOT EXISTS \(SELECT 1 FROM/g, 'EXISTS (SELECT 1 FROM');
    expect(inverted).not.toBe(MIGRATION_SQL);

    apply(inverted);

    // The live agent's rows are the ones that went. This is what the real predicate prevents.
    expect(sideRows('alive')).toEqual(ZERO);
    expect(sideRows('ghost-a')).toEqual(ONE_EACH);
  });
});
