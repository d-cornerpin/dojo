// ════════════════════════════════════════════════════════════════════════════════════════
// A PURGE LEAVES NO ROW POINTING AT THE AGENT IT DELETED (BACKLOG LANE-1).
//
// ── THE DEFECT ──
// TEN tables carry a foreign key into `agents`. The purge door named SIX of them inline, and
// the four it missed split into two classes:
//
//   ⚠ `agents.parent_agent` and `briefings` are `NO ACTION`. With `foreign_keys = ON` — what
//     `db/connection.ts` sets — `DELETE FROM agents` against a row another agent names as its
//     parent, or that owns a briefing, FAILS THE FK CHECK AND THE PURGE ERRORS OUT. Those are
//     not tidiness items; they are two ways the door was already broken, and `briefings` being
//     empty on the owner's box is the only reason the second has not been hit.
//
//   • `grant_rule`, `drain_state` and `error_loop_state` are `CASCADE`, so the door got away
//     with naming none of them — as long as whoever opened the connection set the pragma.
//     `memory/message-store.ts` already wrote down why that is not good enough, and this lane
//     measured the consequence: 2,252 `audit_log` + 284 `grant_rule` + 3 `drain_state` orphan
//     rows on the owner's body, every one minted by a writer whose connection had FKs OFF.
//
// ── THE CLAUSE THAT MATTERS MOST IS THE CENSUS ──
// Clauses for the four known tables would be a snapshot of today's schema. The last describe
// block instead ASKS THE DATABASE which tables reference `agents` and requires that a purged
// agent is named by none of them. Add an eleventh table with an FK to `agents` and forget to
// sweep it, and that clause goes red without anybody editing this file — which is the failure
// mode that produced this lane's work in the first place.
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-purge-orphans', 'dojo.db'),
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
import { insertMessage } from '../../../memory/message-store.js';
import { agentsRouter } from '../agents.js';

const db = (): Database.Database => mockDb.current!;

const purge = (id: string): Promise<Response> =>
  agentsRouter.request(`/${id}/purge`, { method: 'POST' });

const n = (sql: string, ...args: unknown[]): number =>
  (db().prepare(sql).get(...args) as { n: number }).n;

const fkViolations = (): unknown[] => db().prepare('PRAGMA foreign_key_check').all();

/** Every table that declares a foreign key into `agents`, read from the live schema. */
function tablesReferencingAgents(): Array<{ table: string; column: string; onDelete: string }> {
  const tables = (db().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(r => r.name);
  const out: Array<{ table: string; column: string; onDelete: string }> = [];
  for (const t of tables) {
    const fks = db().prepare(`PRAGMA foreign_key_list("${t}")`).all() as
      Array<{ table: string; from: string; on_delete: string }>;
    for (const fk of fks) {
      if (fk.table === 'agents') out.push({ table: t, column: fk.from, onDelete: fk.on_delete });
    }
  }
  return out;
}

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

const seedAgent = (id: string, status = 'terminated', parent: string | null = null): void => {
  db().prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, parent_agent, created_by, created_at, updated_at)
    VALUES (?, ?, 'm1', ?, '{}', 1, ?, 'owner', datetime('now'), datetime('now'))
  `).run(id, id, status, parent);
};

/** One row in every table that hangs off an agent, so a sweep has something to miss. */
const seedSideRows = (agentId: string): void => {
  const d = db();
  d.prepare(`INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
             VALUES (?, ?, 'tool_call', '/tmp/x', 'success', 'ok', datetime('now'))`)
    .run(`audit-${agentId}`, agentId);
  d.prepare(`INSERT INTO grant_rule (agent_id, effect_kind, mode, pattern, source, manifest_fingerprint)
             VALUES (?, 'fs_read', 'allow', '*', 'manifest', 'fp')`).run(agentId);
  d.prepare(`INSERT INTO briefings (id, agent_id, content, token_count)
             VALUES (?, ?, 'a briefing', 12)`).run(`brief-${agentId}`, agentId);
  d.prepare(`INSERT INTO context_items (agent_id, item_type, item_id, ordinal)
             VALUES (?, 'note', ?, 0)`).run(agentId, `ctx-${agentId}`);
  d.prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count,
                                    earliest_at, latest_at, created_at)
             VALUES (?, ?, 1, 'condensed', 'sum', 10,
                     datetime('now'), datetime('now'), datetime('now'))`)
    .run(`sum-${agentId}`, agentId);
};

const sideRowCount = (agentId: string): Record<string, number> => ({
  audit_log: n('SELECT COUNT(*) AS n FROM audit_log WHERE agent_id = ?', agentId),
  grant_rule: n('SELECT COUNT(*) AS n FROM grant_rule WHERE agent_id = ?', agentId),
  briefings: n('SELECT COUNT(*) AS n FROM briefings WHERE agent_id = ?', agentId),
  context_items: n('SELECT COUNT(*) AS n FROM context_items WHERE agent_id = ?', agentId),
  summaries: n('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?', agentId),
});

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

// ── THE TWO THAT MADE THE DOOR RAISE ─────────────────────────────────────────────────────

describe('the two NO ACTION references that made a purge FAIL', () => {
  it('⚠ purging a PARENT succeeds, and its child survives with the link nulled', async () => {
    seedAgent('doomed');
    seedAgent('child', 'idle', 'doomed');
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE parent_agent = ?', 'doomed')).toBe(1);

    const res = await purge('doomed');
    expect(res.status).toBe(200);

    // The agent is gone…
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'doomed')).toBe(0);
    // …the CHILD IS NOT. Following the link would be an unbounded blast radius.
    const child = db().prepare('SELECT id, status, parent_agent FROM agents WHERE id = ?').get('child') as
      { id: string; status: string; parent_agent: string | null } | undefined;
    expect(child).toBeDefined();
    expect(child?.status).toBe('idle');
    expect(child?.parent_agent).toBeNull();
    expect(fkViolations()).toEqual([]);
  });

  it('⚠ purging an agent that owns a BRIEFING succeeds, and the briefing goes', async () => {
    seedAgent('doomed');
    db().prepare(`INSERT INTO briefings (id, agent_id, content, token_count)
                  VALUES ('b1', 'doomed', 'a briefing', 12)`).run();

    const res = await purge('doomed');
    expect(res.status).toBe(200);

    expect(n('SELECT COUNT(*) AS n FROM briefings WHERE agent_id = ?', 'doomed')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'doomed')).toBe(0);
    expect(fkViolations()).toEqual([]);
  });

  it('a grandchild chain: only the purged agent goes, the rest keep their own links', async () => {
    seedAgent('doomed');
    seedAgent('child', 'idle', 'doomed');
    seedAgent('grandchild', 'idle', 'child');

    expect((await purge('doomed')).status).toBe(200);

    expect(n('SELECT COUNT(*) AS n FROM agents')).toBe(2);
    const gc = db().prepare('SELECT parent_agent FROM agents WHERE id = ?').get('grandchild') as
      { parent_agent: string | null };
    expect(gc.parent_agent).toBe('child');   // untouched — it never named the purged agent
    expect(fkViolations()).toEqual([]);
  });
});

// ── THE CASCADE TABLES, SWEPT EXPLICITLY ─────────────────────────────────────────────────

describe('the side tables are swept by the door, not by a pragma', () => {
  it('every table that hangs off the agent is empty afterwards', async () => {
    seedAgent('doomed');
    seedSideRows('doomed');
    const before = sideRowCount('doomed');
    for (const [t, c] of Object.entries(before)) expect(c, `${t} seeded`).toBeGreaterThan(0);

    expect((await purge('doomed')).status).toBe(200);

    expect(sideRowCount('doomed')).toEqual({
      audit_log: 0, grant_rule: 0, briefings: 0, context_items: 0, summaries: 0,
    });
    expect(fkViolations()).toEqual([]);
  });

  it('NEGATIVE CONTROL — another agent keeps every one of its rows', async () => {
    seedAgent('doomed');
    seedAgent('keeper', 'idle');
    seedSideRows('doomed');
    seedSideRows('keeper');

    expect((await purge('doomed')).status).toBe(200);

    expect(sideRowCount('keeper')).toEqual({
      audit_log: 1, grant_rule: 1, briefings: 1, context_items: 1, summaries: 1,
    });
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'keeper')).toBe(1);
  });

  it('⚠ WITH `foreign_keys = OFF` the sweep STILL leaves nothing — which is the whole point', async () => {
    // THIS IS THE CLAUSE THAT MAKES THE THREE `CASCADE` DELETES LOAD-BEARING. With the pragma ON
    // the database would clean `grant_rule`, `drain_state` and `error_loop_state` up whatever the
    // door did, so a test run under `foreign_keys = ON` cannot tell a door that sweeps them from
    // one that forgets them. OFF is not a hypothetical setting either: it is what the migration
    // chain runs under, and what every `sqlite3` CLI writer gets by default — which is exactly
    // how the 2,252 + 284 + 3 orphan rows migration 173 sweeps were minted.
    db().pragma('foreign_keys = OFF');
    expect(db().pragma('foreign_keys', { simple: true })).toBe(0);

    seedAgent('doomed');
    seedSideRows('doomed');
    db().prepare(`INSERT INTO drain_state (agent_id, drain, head, stuck, updated_at)
                  VALUES (?, 'unserved_wake', '', 0, ?)`).run('doomed', Date.now());

    expect((await purge('doomed')).status).toBe(200);

    // Nothing here can be credited to the database: the pragma is off.
    expect(sideRowCount('doomed')).toEqual({
      audit_log: 0, grant_rule: 0, briefings: 0, context_items: 0, summaries: 0,
    });
    expect(n('SELECT COUNT(*) AS n FROM drain_state WHERE agent_id = ?', 'doomed')).toBe(0);
    for (const { table, column } of tablesReferencingAgents()) {
      expect(n(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, 'doomed'),
        `${table}.${column} survived a FK-OFF purge`).toBe(0);
    }
  });

  it('NEGATIVE CONTROL — the gates still refuse a live agent, sweeping nothing', async () => {
    seedAgent('alive', 'idle');
    seedSideRows('alive');

    const res = await purge('alive');
    expect(res.status).toBe(400);
    expect(sideRowCount('alive')).toEqual({
      audit_log: 1, grant_rule: 1, briefings: 1, context_items: 1, summaries: 1,
    });
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'alive')).toBe(1);
  });
});

// ── THE CENSUS, WHICH IS THE CLAUSE A FUTURE TABLE CANNOT SLIP PAST ──────────────────────

describe('the census — no table that references agents is forgotten', () => {
  it('names the ten references the schema declares today, so a new one is visible', () => {
    const refs = tablesReferencingAgents();
    const seen = refs.map(r => `${r.table}.${r.column}`).sort();
    expect(seen).toEqual([
      'agents.parent_agent',
      'audit_log.agent_id',
      'briefings.agent_id',
      'context_items.agent_id',
      'drain_state.agent_id',
      'error_loop_state.agent_id',
      'grant_rule.agent_id',
      'large_files.agent_id',
      'messages.agent_id',
      'summaries.agent_id',
    ]);
    // Non-vacuity: an empty census would pass every clause below it.
    expect(refs.length).toBe(10);
  });

  it('⚠ after a purge, NOT ONE of those tables still names the agent', async () => {
    seedAgent('doomed');
    seedSideRows('doomed');
    seedAgent('child', 'idle', 'doomed');
    db().prepare(`INSERT INTO drain_state (agent_id, drain, head, stuck, updated_at)
                  VALUES (?, 'unserved_wake', '', 0, ?)`).run('doomed', Date.now());
    // Built by the PRODUCT's own writer rather than hand-rolled: `messages` carries a dozen
    // CHECK constraints and a fixture that guesses them drifts the moment one changes.
    insertMessage({ agentId: 'doomed', role: 'user', content: 'hi' });

    expect((await purge('doomed')).status).toBe(200);

    // Asked of the SCHEMA, not of a hand-written list. A table added later is covered.
    for (const { table, column } of tablesReferencingAgents()) {
      const left = n(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`, 'doomed');
      expect(left, `${table}.${column} still names the purged agent`).toBe(0);
    }
    expect(fkViolations()).toEqual([]);
  });
});

// ── ONE UNIT: A PURGE THAT FAILS PART-WAY LEAVES THE AGENT WHOLE ─────────────────────────

describe('the purge is one transaction', () => {
  it('⚠ a failure at the LAST statement rolls back every delete before it', async () => {
    // Before this door was one unit it was a bare run of `db.prepare().run()` calls, so a
    // failure part-way left a HALF-PURGED agent: side rows gone, agent still listed, and no
    // way for the operator to tell. The failure is injected with a trigger on the final
    // statement rather than by breaking a collaborator, so every earlier delete really has
    // run and really has to be undone.
    seedAgent('doomed');
    seedSideRows('doomed');
    insertMessage({ agentId: 'doomed', role: 'user', content: 'hi' });
    const before = sideRowCount('doomed');
    const messagesBefore = n('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', 'doomed');
    expect(messagesBefore).toBeGreaterThan(0);

    db().exec(`CREATE TRIGGER purge_boom BEFORE DELETE ON agents
               BEGIN SELECT RAISE(ABORT, 'injected failure at the last statement'); END`);
    try {
      const res = await purge('doomed');
      // However the route reports it, it must NOT report success.
      expect(res.status).not.toBe(200);
    } finally {
      db().exec('DROP TRIGGER purge_boom');
    }

    // EVERY row is back. This is the clause `withUnit` exists for.
    expect(sideRowCount('doomed')).toEqual(before);
    expect(n('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', 'doomed')).toBe(messagesBefore);
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'doomed')).toBe(1);
    expect(fkViolations()).toEqual([]);
  });

  it('NEGATIVE CONTROL — with no trigger the same fixture purges clean', async () => {
    // Without this, the clause above would pass on a door that never deletes anything.
    seedAgent('doomed');
    seedSideRows('doomed');
    insertMessage({ agentId: 'doomed', role: 'user', content: 'hi' });

    expect((await purge('doomed')).status).toBe(200);

    expect(sideRowCount('doomed')).toEqual({
      audit_log: 0, grant_rule: 0, briefings: 0, context_items: 0, summaries: 0,
    });
    expect(n('SELECT COUNT(*) AS n FROM agents WHERE id = ?', 'doomed')).toBe(0);
  });
});
