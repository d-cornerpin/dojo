// ════════════════════════════════════════════════════════════════════════════════════════
// THE TWO HOT `audit_log` READS, MEASURED AT GROWN SCALE (W2-B item E).
//
// ── THE ITEM, AND WHAT MEASURING IT SETTLED ──
// The backlog line reads *"audit_log has no (agent_id, created_at) index — highest-volume
// table in the report gather; T8 will measure"*. It HAS one: migration `171` created
// `idx_audit_log_agent_created` and `db/__tests__/migration-171-report-read-indexes.test.ts`
// already pins `readAudit`'s plan. The backlog line predates that migration, so item E is not
// a missing index — it is the measurement nobody had taken, and the grown-box rule says take
// it before believing either answer.
//
// `audit_log` had TWO single-column indexes before `171` — `(agent_id)` and `(created_at)` —
// and SQLite uses at most one index per table per query, so either choice left the other half
// of `WHERE agent_id = ? AND created_at >= ?` as a filter-and-sort. That is what `171` closed.
//
// ── WHAT THIS FILE ADDS, AND WHY IT IS NOT A DUPLICATE OF 171's ──
// `171`'s clauses run on a small fixture and cover the report gather's read. Two gaps:
//
//   1. a plan on a few hundred rows proves the index is USABLE, not that the planner PICKS it
//      once the table is the size the line is worried about. This fixture is 200,000 rows.
//   2. the DASHBOARD's hot read was never pinned at all — and it is the one with a finding.
//
// ── THE FINDING, WHICH IS A HAND-UP AND NOT A FIX HERE ──
// `gateway/routes/tracker.ts`'s PM-cost read filters
// `datetime(created_at) > datetime('now', '-1 day')`. Wrapping the indexed column in a
// function makes that half NON-SARGABLE: SQLite cannot seek the `created_at` leg of the
// composite, so the query seeks `agent_id` and then evaluates `datetime()` on every one of
// that agent's rows. The index still helps — the agent seek is the expensive half — but the
// range is a scan of one agent's history rather than a seek into a window of it, and it gets
// slower every day the platform runs. `created_at` is stored as `datetime('now')` text, which
// is already lexicographically ordered, so the wrapper buys nothing a direct string compare
// would not: `created_at > datetime('now','-1 day')` is the sargable spelling of the same
// question. That file is outside this lane's fence, so the change is handed up with the
// numbers below rather than made here — and the clause PINS TODAY'S PLAN so the hand-up is
// a measured claim and the day somebody fixes it, this clause tells them it worked.
//
// Timings are reported, never asserted — seven lanes share this box and a wall-clock
// assertion on a loaded machine is a coin flip. The PLAN is the assertion.
//
// Every agent id and row below is fictional and generated.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-grown-audit');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-grown-audit', 'dojo.db'),
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

import { runMigrations } from '../migrations.js';

const db = (): Database.Database => mockDb.current!;

const AUDIT_INDEX = 'idx_audit_log_agent_created';
const AUDIT_ROWS = 200_000;
const AGENTS = 40;
/** The agent the reads below ask about — the busiest one, which is the honest case. */
const HOT_AGENT = 'agent-fixture-00';

// ── THE TWO HOT READS, VERBATIM FROM THE SOURCE THEY MEASURE ─────────────────────────────

/** `report/collect.ts`'s `readAudit` — the report gather's read, the one the line names. */
const REPORT_GATHER = `
  SELECT action_type, target, result, detail, call_id, created_at
    FROM audit_log WHERE agent_id = ? AND created_at >= ?
   ORDER BY created_at DESC, id DESC LIMIT 200`;

/** `gateway/routes/tracker.ts`'s PM-cost read — the dashboard's, with the `datetime()` wrapper. */
const DASHBOARD_PM_COST = `
  SELECT target as modelId, COUNT(*) as calls,
         ROUND(COALESCE(SUM(cost), 0), 4) as cost_24h
    FROM audit_log
   WHERE agent_id = ?
     AND action_type = 'model_call'
     AND datetime(created_at) > datetime('now', '-1 day')
   GROUP BY target`;

/** The same question asked sargably — what the hand-up proposes. Measured, not just argued. */
const DASHBOARD_SARGABLE = DASHBOARD_PM_COST.replace(
  "datetime(created_at) > datetime('now', '-1 day')",
  "created_at > datetime('now', '-1 day')",
);

const planOf = (sql: string, ...args: unknown[]): string =>
  (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map(r => r.detail).join(' | ');

/** Wall clock over `runs` executions, in milliseconds. Reported, never asserted. */
function timeOf(sql: string, args: unknown[], runs = 20): number {
  const stmt = db().prepare(sql);
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) stmt.all(...args);
  return (performance.now() - t0) / runs;
}

const SINCE = '2026-01-01 00:00:00';
const measurements: string[] = [];

beforeAll(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  const d = db();

  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))
  `).run();
  d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))
  `).run();

  const insAgent = d.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
    VALUES (?, ?, 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))
  `);
  const ids: string[] = [];
  for (let i = 0; i < AGENTS; i++) {
    const id = `agent-fixture-${String(i).padStart(2, '0')}`;
    ids.push(id);
    insAgent.run(id, id);
  }

  // A fictional year of audit rows. The hot agent gets a quarter of them, so the busiest
  // agent's slice is itself large — a uniform spread would flatter every plan.
  const ins = d.prepare(`
    INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
    VALUES (?, ?, ?, ?, 'success', '{}', 0.0001, ?)
  `);
  const kinds = ['model_call', 'tool_call', 'file_read', 'exec'];
  const start = Date.UTC(2026, 0, 1);
  d.transaction(() => {
    for (let i = 0; i < AUDIT_ROWS; i++) {
      const agent = i % 4 === 0 ? HOT_AGENT : ids[i % AGENTS];
      const at = new Date(start + i * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      ins.run(`audit-${i}`, agent, kinds[i % kinds.length], `model-${i % 7}`, at);
    }
  })();
});

afterAll(() => {
  // The numbers are the deliverable, so they go where a reader of the run can see them.
  if (measurements.length > 0) console.info(`\nitem E measurements\n${measurements.join('\n')}`);
  mockDb.current?.close();
  mockDb.current = null;
});

// ── THE FIXTURE IS ACTUALLY GROWN ────────────────────────────────────────────────────────

describe('the fixture is the size the question is about', () => {
  it('carries 200,000 audit rows, and the hot agent owns a large slice of them', () => {
    const total = (db().prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    const hot = (db().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE agent_id = ?')
      .get(HOT_AGENT) as { n: number }).n;
    expect(total).toBe(AUDIT_ROWS);
    expect(hot).toBeGreaterThan(AUDIT_ROWS / 5);
    measurements.push(`fixture: ${total} audit_log rows across ${AGENTS} agents; hot agent holds ${hot}`);
  });

  it('all three audit indexes 171 left in place are present', () => {
    const names = (db().prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log' ORDER BY name",
    ).all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'idx_audit_log_agent_id', 'idx_audit_log_created_at', AUDIT_INDEX,
    ]));
  });
});

// ── THE REPORT GATHER: THE INDEX IS PICKED, AND IT IS THE COMPOSITE ──────────────────────

describe('the report gather’s read', () => {
  it('⚠ seeks BOTH halves of the composite at 200,000 rows', () => {
    const plan = planOf(REPORT_GATHER, HOT_AGENT, SINCE);
    expect(plan).toContain(AUDIT_INDEX);
    // Both legs in the seek, which is the whole point of the composite over the two singles.
    expect(plan).toMatch(/agent_id=\?/);
    expect(plan).toMatch(/created_at>\?/);
    expect(plan).not.toContain('SCAN audit_log');
    measurements.push(`report gather WITH    ${AUDIT_INDEX}: ${plan}`);
  });

  it('WITHOUT the composite it falls back to a single-column index and a SORT', () => {
    db().exec(`DROP INDEX ${AUDIT_INDEX}`);
    try {
      const plan = planOf(REPORT_GATHER, HOT_AGENT, SINCE);
      expect(plan).not.toContain(AUDIT_INDEX);
      // The fallback cannot seek both legs, so the ORDER BY becomes a real sort.
      expect(plan).toMatch(/SCAN|SEARCH/);
      measurements.push(`report gather WITHOUT ${AUDIT_INDEX}: ${plan}`);
      const without = timeOf(REPORT_GATHER, [HOT_AGENT, SINCE]);
      db().exec(`CREATE INDEX ${AUDIT_INDEX} ON audit_log (agent_id, created_at)`);
      const with_ = timeOf(REPORT_GATHER, [HOT_AGENT, SINCE]);
      measurements.push(
        `report gather timing: without ${without.toFixed(2)} ms/call, with ${with_.toFixed(2)} ms/call `
        + `(mean of 20; wall clock on a shared box, reported not asserted)`,
      );
    } finally {
      db().exec(`CREATE INDEX IF NOT EXISTS ${AUDIT_INDEX} ON audit_log (agent_id, created_at)`);
    }
    expect(planOf(REPORT_GATHER, HOT_AGENT, SINCE)).toContain(AUDIT_INDEX);
  });
});

// ── THE DASHBOARD: TODAY'S PLAN PINNED, AND THE SARGABLE SPELLING MEASURED BESIDE IT ─────

describe('the dashboard’s PM-cost read — the `datetime()` wrapper costs the range seek', () => {
  it('⚠ seeks `agent_id` but CANNOT seek `created_at`, because the column is wrapped', () => {
    const plan = planOf(DASHBOARD_PM_COST, HOT_AGENT);
    // It does take an index — the agent seek is real and is the expensive half.
    expect(plan).toMatch(new RegExp(`${AUDIT_INDEX}|idx_audit_log_agent_id`));
    // …but NOT on the second leg. `datetime(created_at)` is not a column reference, so no
    // `created_at>?` can appear in the seek. This is the finding, pinned.
    expect(plan).not.toMatch(/created_at>\?/);
    measurements.push(`dashboard PM-cost (datetime-wrapped) : ${plan}`);
  });

  it('the SARGABLE spelling of the same question seeks both halves', () => {
    const plan = planOf(DASHBOARD_SARGABLE, HOT_AGENT);
    expect(plan).toContain(AUDIT_INDEX);
    expect(plan).toMatch(/created_at>\?/);
    measurements.push(`dashboard PM-cost (sargable)         : ${plan}`);

    const wrapped = timeOf(DASHBOARD_PM_COST, [HOT_AGENT]);
    const sargable = timeOf(DASHBOARD_SARGABLE, [HOT_AGENT]);
    measurements.push(
      `dashboard timing: wrapped ${wrapped.toFixed(2)} ms/call, sargable ${sargable.toFixed(2)} ms/call `
      + `(mean of 20; wall clock on a shared box, reported not asserted)`,
    );
  });

  it('both spellings answer the same question — a faster plan that lies is not a win', () => {
    const a = db().prepare(DASHBOARD_PM_COST).all(HOT_AGENT);
    const b = db().prepare(DASHBOARD_SARGABLE).all(HOT_AGENT);
    expect(b).toEqual(a);
  });
});
