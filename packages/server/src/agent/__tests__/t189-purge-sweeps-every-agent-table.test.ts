// ════════════════════════════════════════════════════════════════════════════
// t189 B4: PURGING AN AGENT LEAVES NOTHING OF IT BEHIND, EXCEPT ITS SPENDING HISTORY.
//
// The purge list was hand-maintained, so every per-agent table added after it was an
// orphan class (the agent's budget row, its tool-failure rows, conversations, receipts,
// vault rows, ...). Owner decision 28: keep the purged agent's SPENDING history for
// cost reports, remove everything else.
//
// THE CENSUS DOES NOT HARD-CODE THE TABLE LIST. It reads `sqlite_master` after the real
// migration chain, finds EVERY table with an `agent_id` column, seeds a row for a doomed
// agent and one for a survivor in each, purges, and asserts: the doomed agent has zero
// rows everywhere except the named keep-list, the survivor lost nothing, and the keep-list
// is exactly what is written below. A table a later migration adds is picked up here by
// the same query, with no edit to this file; a table that must survive a purge has to be
// named in the purge module's keep-list WITH a reason, and in `EXPECTED_KEPT` here.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const m = vi.hoisted(() => ({ db: null as unknown, endedCards: [] as string[] }));
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!m.db) throw new Error('test DB not initialized'); return m.db; },
  closeDb: () => undefined,
  getDbPath: () => '/tmp/t189-purge.db',
}));
// The owner-card broadcast is not this suite's subject; what it is TOLD is.
vi.mock('../agent-owner-cards.js', () => ({ agentPurgedForOwner: () => undefined }));
vi.mock('../../services/owner-card-frames.js', () => ({
  ownerCardEnded: (words: string) => { m.endedCards.push(words); },
}));

import { runMigrations } from '../../db/migrations.js';
import { purgeAgentRows, PURGE_KEEPS } from '../purge.js';

const DOOMED = 'agent-doomed';
const SURVIVOR = 'agent-survivor';

/** Spending history is the only thing the owner asked to keep (decision 28). */
const EXPECTED_KEPT = ['cost_records'];

/** Columns a generic seed cannot guess (a CHECK that is not a plain `col IN (...)` list).
 *  A `col IN ('a','b')` CHECK is read off the table's own SQL and needs no entry here. */
const SEED_OVERRIDES: Record<string, Record<string, unknown>> = {
  // `ended_at` and `exit_reason` must be both set or both null.
  turns: { ended_at: '2026-01-01 00:00:00' },
  // A terminal `state` needs `closed_at`, a live one must not have it.
  work: { state: 'on_deck', closed_at: null },
};

/** `col IN ('first', ...)` / `col IN (1, ...)` from the CREATE statement: the first member. */
function checkInValues(table: string): Record<string, unknown> {
  const sql = (db().prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql;
  const out: Record<string, unknown> = {};
  for (const mt of sql.matchAll(/(\w+)\s+IN\s*\(\s*('([^']*)'|(\d+))/gi)) {
    out[mt[1]!] = mt[3] !== undefined ? mt[3] : Number(mt[4]);
  }
  return out;
}

const db = (): Database.Database => m.db as Database.Database;

function agentTables(): string[] {
  return (db().prepare(
    `SELECT m.name FROM sqlite_master m
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'agent_id')
      ORDER BY m.name`,
  ).all() as Array<{ name: string }>).map((r) => r.name);
}

/** One row for `agentId` in `table`: every NOT NULL column without a default gets a value
 *  of its own type, unique per agent so UNIQUE/PRIMARY KEY columns never collide. */
function seed(table: string, agentId: string): void {
  const cols = db().prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${table}')`)
    .all() as Array<{ name: string; type: string; nn: number; dflt: string | null; pk: number }>;
  const values: Record<string, unknown> = {};
  const checks = checkInValues(table);
  for (const c of cols) {
    if (c.name === 'agent_id') { values[c.name] = agentId; continue; }
    if (SEED_OVERRIDES[table] && c.name in SEED_OVERRIDES[table]!) { values[c.name] = SEED_OVERRIDES[table]![c.name]; continue; }
    if (checks[c.name] !== undefined) { values[c.name] = checks[c.name]; continue; }
    if (!c.nn && !c.pk) continue;
    if (c.dflt !== null) continue;
    const t = c.type.toUpperCase();
    // A millisecond-epoch-sized integer, different per agent: it satisfies the usual
    // `> 1600000000000` timestamp CHECK and never collides on an INTEGER key.
    if (t.includes('INT')) values[c.name] = 1_700_000_000_000 + (agentId === DOOMED ? 1 : 2);
    else if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) values[c.name] = 1;
    else if (t.includes('BLOB')) values[c.name] = Buffer.from([1, 2, 3, 4]);
    else values[c.name] = `${table}.${c.name}.${agentId}`;
  }
  const names = Object.keys(values);
  try {
    db().prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...Object.values(values));
  } catch (err) {
    throw new Error(
      `census could not seed a row in "${table}" (${err instanceof Error ? err.message : String(err)}). ` +
      `Add its constrained columns to SEED_OVERRIDES in this test; do not exempt the table from the census.`,
    );
  }
}

const count = (table: string, agentId: string): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE agent_id = ?`).get(agentId) as { n: number }).n;

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  m.db = d;
  m.endedCards.length = 0;
  runMigrations();
  d.pragma('foreign_keys = OFF');   // seeding only; the purge runs with the production pragma
  d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at)
             VALUES (?, 'doomed role', 'terminated', datetime('now'), datetime('now')),
                    (?, 'survivor role', 'idle', datetime('now'), datetime('now'))`).run(DOOMED, SURVIVOR);
});

afterEach(() => {
  (m.db as Database.Database | null)?.close();
  m.db = null;
});

describe('t189 B4: the purge sweeps every table with an agent_id column', () => {
  it('the keep-list is exactly the spending history, each entry with a reason', () => {
    expect(Object.keys(PURGE_KEEPS).sort()).toEqual(EXPECTED_KEPT);
    for (const [table, why] of Object.entries(PURGE_KEEPS)) {
      expect(why.length, `${table} is kept without a reason`).toBeGreaterThan(20);
    }
  });

  it('the census is not vacuous: it finds the tables the purge always knew and the ones it missed', () => {
    const tables = agentTables();
    expect(tables.length).toBeGreaterThan(30);
    for (const t of ['messages', 'summaries', 'work', 'cost_records', 'agent_tool_failures', 'conversations', 'tool_receipts']) {
      expect(tables, `${t} not found by the schema query`).toContain(t);
    }
  });

  it('a doomed agent has zero rows left in every table but the kept ones; the survivor loses nothing', () => {
    const tables = agentTables();
    for (const t of tables) { seed(t, DOOMED); seed(t, SURVIVOR); }
    db().pragma('foreign_keys = ON');

    purgeAgentRows(DOOMED);

    const leftBehind = tables
      .filter((t) => !EXPECTED_KEPT.includes(t))
      .filter((t) => count(t, DOOMED) > 0);
    expect(leftBehind, `purge left this agent's rows in: ${leftBehind.join(', ')}`).toEqual([]);

    for (const t of EXPECTED_KEPT) expect(count(t, DOOMED), `${t} must keep its rows`).toBeGreaterThan(0);

    const hurt = tables.filter((t) => count(t, SURVIVOR) !== 1);
    expect(hurt, `the survivor lost rows in: ${hurt.join(', ')}`).toEqual([]);
    expect(db().prepare('SELECT 1 FROM agents WHERE id = ?').get(DOOMED)).toBeUndefined();
    expect(db().prepare('SELECT 1 FROM agents WHERE id = ?').get(SURVIVOR)).toBeDefined();
  });

  it('its budget row goes, its live budget card ends, another budget stays', () => {
    db().prepare(`INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period, alert_words) VALUES
      (?, 'agent', 5, 'daily', 'doomed agent is at 90% of its budget'),
      (?, 'agent', 5, 'daily', NULL),
      ('global_daily', 'global', 50, 'daily', NULL)`).run(`agent_${DOOMED}`, `agent_${SURVIVOR}`);
    db().pragma('foreign_keys = ON');

    purgeAgentRows(DOOMED);

    const ids = (db().prepare('SELECT id FROM budgets ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['agent_' + SURVIVOR, 'global_daily'].sort());
    expect(m.endedCards).toContain('doomed agent is at 90% of its budget');
  });

  it('a purge is never blocked by ANOTHER agent\'s work that points at this agent\'s conversation or delivery', () => {
    const d = db();
    d.prepare(`INSERT INTO conversations (id, agent_id, channel) VALUES ('conv-d', ?, 'dashboard')`).run(DOOMED);
    d.prepare(`INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES ('del-d', ?, 'send', 'dashboard', 'delivered')`).run(DOOMED);
    seed('work', SURVIVOR);
    d.prepare(`UPDATE work SET conversation_id = 'conv-d', result_delivery_id = 'del-d' WHERE agent_id = ?`).run(SURVIVOR);
    d.pragma('foreign_keys = ON');

    expect(() => purgeAgentRows(DOOMED)).not.toThrow();

    const row = d.prepare('SELECT conversation_id AS c, result_delivery_id AS r FROM work WHERE agent_id = ?').get(SURVIVOR) as { c: unknown; r: unknown };
    expect(row).toEqual({ c: null, r: null });
    expect(count('conversations', DOOMED)).toBe(0);
  });

  it('a delivery that is the evidence of ANOTHER agent\'s done work survives the purge, and the purge completes', () => {
    const d = db();
    const THIRD = 'agent-third';
    d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at) VALUES (?, 'third role', 'idle', datetime('now'), datetime('now'))`).run(THIRD);
    d.prepare(`INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES ('del-ev', ?, 'send', 'dashboard', 'delivered')`).run(DOOMED);
    seed('work', THIRD);
    d.prepare(`UPDATE work SET state = 'done', closed_at = 1700000000999, result_delivery_id = 'del-ev' WHERE agent_id = ?`).run(THIRD);
    d.pragma('foreign_keys = ON');

    expect(() => purgeAgentRows(DOOMED)).not.toThrow();

    expect(d.prepare("SELECT 1 FROM deliveries WHERE id = 'del-ev'").get()).toBeDefined();
  });
});
