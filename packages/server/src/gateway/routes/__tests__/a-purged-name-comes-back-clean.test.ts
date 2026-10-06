// ════════════════════════════════════════════════════════════════════════════════════════
// THE BACKWARDS-LIFECYCLE PROBE: create -> schedule -> purge -> re-create the same name
// (W2-B item A, feature-testing standing order).
//
// ── WHAT THIS ADDS TO THE TWO CLAUSE FILES BESIDE IT ──
// `a-purge-leaves-no-orphan-row.test.ts` pins the TEN tables that declare a foreign key into
// `agents` and requires a purged agent be named by none of them.
// `a-purge-takes-the-work-with-it.test.ts` does the same for the work spine.
// Both read their table list out of `PRAGMA foreign_key_list`, so both count on the FK axis.
//
// Neither can see a SOFT reference — a column that carries an agent's identity with no foreign
// key declared on it. Those exist and are deliberate: `work.agent_id` has no FK at all
// (migration 135, PART 0 rider 1 keeps a work row readable after its agent is gone), and
// `work.requester_id` carries "who asked for this" as provenance. A census built from the
// schema's declarations is structurally blind to every one of them.
//
// So this file asks the question from the other end, and asks it of the WHOLE DATABASE rather
// than of a list: after the purge, scan every column of every table for the literal id, and
// require the surviving hits to equal a DECLARED set with a reason each. A new soft reference
// — a column added next year that quietly stores an agent id — lands in the scan and fails
// here, which is the one direction no FK census can cover.
//
// The second half is the lifecycle the standing order names. A purged name is re-created and
// must inherit nothing: identity on this platform is the uuid, not the name, and that is a
// property worth pinning rather than assuming, because every reader that scopes by name
// instead of id would break it silently.
//
// Driven through `POST /api/agents/:id/purge`, the door the dashboard's delete-agent flow
// uses, so this also holds that flow working. All agents and rows are fictional.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-purge-lifecycle', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
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
const NOW = 1_790_000_000_000;

const purge = (id: string): Promise<Response> =>
  agentsRouter.request(`/${id}/purge`, { method: 'POST' });

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;
const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

// ── THE WHOLE-DATABASE SCAN ──────────────────────────────────────────────────────────────

/** Every (table, column) pair that could hold text, read from the live schema. */
function textColumns(): Array<{ table: string; column: string }> {
  const tables = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  const out: Array<{ table: string; column: string }> = [];
  for (const t of tables) {
    // An FTS shadow table answers queries, not `=` scans, and is rebuilt from its content
    // table — so scanning it would report the same row twice and in a shape SQLite refuses.
    if (/_fts(_|$)|_(data|idx|content|docsize|config)$/.test(t)) continue;
    const cols = db().prepare(`PRAGMA table_info("${t}")`).all() as
      Array<{ name: string; type: string }>;
    for (const c of cols) {
      if (/INT|REAL|BLOB|NUM/i.test(c.type) && !/TEXT/i.test(c.type)) continue;
      out.push({ table: t, column: c.name });
    }
  }
  return out;
}

/** Where this exact string still appears, anywhere in the body. */
function sightingsOf(value: string): Array<{ at: string; rows: number }> {
  const out: Array<{ at: string; rows: number }> = [];
  for (const { table, column } of textColumns()) {
    const rows = n(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, value);
    if (rows > 0) out.push({ at: `${table}.${column}`, rows });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// ── THE FIXTURE: A WHOLE LIFE, THEN A BYSTANDER WHO REMEMBERS IT ─────────────────────────

const OLD_ID = 'agent-old-0001';
const NEW_ID = 'agent-new-0002';
const SHARED_NAME = 'Archivist';

const seedProvider = (): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))
  `).run();
  db().prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))
  `).run();
};

const seedAgent = (id: string, name: string, status = 'terminated', parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by,
                        parent_agent, created_at, updated_at)
    VALUES (?, ?, 'm1', ?, '{}', 1, 'owner', ?, datetime('now'), datetime('now'))
  `).run(id, name, status, parent);
};

/** One schedulable work row owned by `agent`, requested by `requester` — plus its event and
 *  its verdict, which is the pair a purge has to take with the row. */
const seedWork = (p: { id: string; owner: string; requester: string; state?: string; parent?: string | null }): void => {
  db().prepare(`
    INSERT INTO work (id, kind, parent_id, agent_id, requester, requester_id, root_kind, root_id,
                      state, intent, wakes, closes_thread, title, opened_at, updated_at,
                      schedule_json, next_run_at, sequence)
    VALUES (?, 'task', ?, ?, 'agent', ?, 'legacy', 'legacy', ?, 'FYI', 0, 0, 'a chore', ?, ?,
            '{"every":"day"}', ?, 0)
  `).run(p.id, p.parent ?? null, p.owner, p.requester, p.state ?? 'on_deck', NOW, NOW, NOW + 86_400_000);
  db().prepare(`INSERT INTO work_events (work_id, kind, payload, actor, created_at)
                VALUES (?, 'opened', '{}', 'owner', ?)`).run(p.id, NOW);
  db().prepare(`INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at)
                VALUES (?, 'done', 'upheld', 'owner', ?)`).run(p.id, NOW);
};

/** Every agent-owned side table the door sweeps, so the scan has something to find. Shapes
 *  taken from `a-purge-leaves-no-orphan-row.test.ts` rather than re-guessed — these tables
 *  carry CHECK constraints and a fixture that invents its own columns proves itself. */
const seedSideRows = (id: string): void => {
  const d = db();
  d.prepare(`INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
             VALUES (?, ?, 'tool_call', '/tmp/x', 'success', 'ok', datetime('now'))`)
    .run(`audit-${id}`, id);
  d.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, source, manifest_fingerprint)
             VALUES (?, 'fs_read', 'allow', '*', 'manifest', 'fp')`).run(id);
  d.prepare(`INSERT INTO briefings (id, agent_id, content, token_count)
             VALUES (?, ?, 'a briefing', 12)`).run(`brief-${id}`, id);
  d.prepare(`INSERT INTO context_items (agent_id, item_type, item_id, ordinal)
             VALUES (?, 'note', ?, 0)`).run(id, `ctx-${id}`);
  d.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count,
                                    earliest_at, latest_at, created_at)
             VALUES (?, ?, 1, 'condensed', 'sum', 10,
                     datetime('now'), datetime('now'), datetime('now'))`)
    .run(`sum-${id}`, id);
  d.prepare(`INSERT INTO drain_state (agent_id, drain, head, stuck, updated_at)
             VALUES (?, 'unserved_wake', '', 0, ?)`).run(id, NOW);
};

/**
 * The whole life: the agent, a child agent, its own scheduled work (parent and child rows, the
 * shape a naive delete cannot do), a technique it built, every side table — and a BYSTANDER
 * agent whose own work row names the doomed agent as its REQUESTER. That last row is the soft
 * reference: no foreign key declares it, so no census sees it, and it survives the purge by
 * design because it belongs to an agent who is still here.
 */
const seedTheWholeLife = (): void => {
  seedAgent(OLD_ID, SHARED_NAME);
  seedAgent('agent-child', 'Apprentice', 'idle', OLD_ID);
  seedAgent('agent-bystander', 'Bystander', 'idle');
  seedWork({ id: 'w-parent', owner: OLD_ID, requester: OLD_ID });
  seedWork({ id: 'w-child', owner: OLD_ID, requester: OLD_ID, parent: 'w-parent' });
  db().prepare(`
    INSERT INTO techniques (id, name, state, directory_path, build_project_id, created_at, updated_at)
    VALUES ('tech-1', 'A technique', 'published', '/tmp/tech-1', 'w-parent', datetime('now'), datetime('now'))
  `).run();
  seedSideRows(OLD_ID);
  // The bystander's row, requested by the agent about to be purged.
  seedWork({ id: 'w-bystander', owner: 'agent-bystander', requester: OLD_ID, state: 'open' });
  seedSideRows('agent-bystander');
};

/**
 * Every place a purge is allowed to leave the old id behind, with the reason. An empty list
 * would be a stronger promise than this platform makes, and saying so is the point: these are
 * PROVENANCE columns on rows that belong to somebody still here, and clearing them would edit
 * another agent's history to tidy up after a deletion.
 */
const DECLARED_SURVIVORS: Record<string, string> = {
  'work.requester_id': 'Who ASKED for the work. The row belongs to the bystander agent, who is '
    + 'still here; rewriting its provenance because the requester was deleted would be a lie '
    + 'about that row. No foreign key declares this column, deliberately — migration 135 PART 0 '
    + 'rider 1 keeps the spine readable after an agent is gone.',
};

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  db().pragma('foreign_keys = ON');
  expect(db().pragma('foreign_keys', { simple: true })).toBe(1);
  seedProvider();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the whole-database scan — a soft reference has nowhere to hide', () => {
  it('the scan is not blind: before the purge it finds the agent all over the body', () => {
    seedTheWholeLife();
    const seen = sightingsOf(OLD_ID).map(s => s.at);
    // Non-vacuity, and it has to be a real spread rather than one lucky column.
    expect(seen.length).toBeGreaterThan(8);
    expect(seen).toContain('agents.id');
    expect(seen).toContain('work.agent_id');          // the column with NO foreign key
    expect(seen).toContain('work.requester_id');      // the soft provenance reference
    expect(seen).toContain('agents.parent_agent');
  });

  it('⚠ after the purge, the ONLY sightings left are the declared ones', async () => {
    seedTheWholeLife();

    expect((await purge(OLD_ID)).status).toBe(200);

    const left = sightingsOf(OLD_ID);
    expect(left.map(s => s.at)).toEqual(Object.keys(DECLARED_SURVIVORS).sort());
    // Every declared survivor carries a reason, so the list cannot grow by a bare string.
    for (const s of left) {
      expect(DECLARED_SURVIVORS[s.at]?.length ?? 0, `${s.at} has no recorded reason`)
        .toBeGreaterThan(80);
    }
    expect(fkViolations()).toEqual([]);
  });

  it('the survivor is the BYSTANDER’s row, not a leftover of the purged agent', async () => {
    seedTheWholeLife();

    await purge(OLD_ID);

    const rows = db().prepare('SELECT id, agent_id AS owner FROM work ORDER BY id').all();
    expect(rows).toEqual([{ id: 'w-bystander', owner: 'agent-bystander' }]);
  });

  it('NEGATIVE CONTROL — the bystander keeps every one of its own rows', async () => {
    seedTheWholeLife();
    const before = sightingsOf('agent-bystander');

    await purge(OLD_ID);

    expect(sightingsOf('agent-bystander')).toEqual(before);
  });
});

describe('create -> schedule -> purge -> re-create the same name', () => {
  it('⚠ the re-created name inherits NOTHING from the agent that carried it', async () => {
    seedTheWholeLife();
    expect(n('SELECT COUNT(*) AS n FROM work WHERE agent_id = ?', OLD_ID)).toBe(2);

    expect((await purge(OLD_ID)).status).toBe(200);

    // Same name, new identity — which is what a user re-creating a deleted agent does.
    seedAgent(NEW_ID, SHARED_NAME, 'idle');

    // Asked of the SCHEMA so a table added later is covered: nothing anywhere names the new
    // agent except its own `agents` row.
    expect(sightingsOf(NEW_ID).map(s => s.at)).toEqual(['agents.id']);
    // And the name itself carries no history either — identity here is the uuid.
    const byName = sightingsOf(SHARED_NAME);
    expect(byName).toEqual([{ at: 'agents.name', rows: 1 }]);
  });

  it('⚠ the scheduler polls an empty on_deck — no timer is armed for the agent that left', async () => {
    seedTheWholeLife();
    expect(n("SELECT COUNT(*) AS n FROM work WHERE state = 'on_deck' AND agent_id = ?", OLD_ID)).toBe(2);

    await purge(OLD_ID);
    seedAgent(NEW_ID, SHARED_NAME, 'idle');

    expect(n("SELECT COUNT(*) AS n FROM work WHERE state = 'on_deck'")).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM work WHERE agent_id = ?', NEW_ID)).toBe(0);
  });

  it('the child agent survived its parent and the technique survived its builder', async () => {
    seedTheWholeLife();

    await purge(OLD_ID);

    expect(db().prepare('SELECT parent_agent AS p FROM agents WHERE id = ?').get('agent-child'))
      .toEqual({ p: null });
    expect(db().prepare('SELECT build_project_id AS b FROM techniques WHERE id = ?').get('tech-1'))
      .toEqual({ b: null });
  });
});
