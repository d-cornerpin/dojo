// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT GATHER'S `audit_log` READ, MEASURED AT GROWN SCALE.
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
// ── WHAT THIS FILE ADDS ──
// `171`'s clauses run on a small fixture; a plan on a few hundred rows proves the index is
// USABLE, not that the planner PICKS it at the size the line is worried about. This fixture
// is 200,000 rows.
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
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-grown-audit');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-grown-audit', 'dojo.db'),
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

// ── THE HOT READ, VERBATIM FROM THE SOURCE IT MEASURES ─────────────────────────────

/** `report/collect.ts`'s `readAudit` — the report gather's read, the one the line names. */
const REPORT_GATHER = `
  SELECT action_type, target, result, detail, call_id, created_at
    FROM audit_log WHERE agent_id = ? AND created_at >= ?
   ORDER BY created_at DESC, id DESC LIMIT 200`;

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
  // ── THE LAST SLICE STRADDLES `now`, AND IT HAS TO (t112, 2026-10-05) ──────────────────
  // The body of this fixture is a fictional year starting 2026-01-01, one row a minute. The
  // dashboard read asks for the last 24 HOURS, so on any day after the 200,000th minute
  // (≈2026-05-19) EVERY row is outside the window and the read returns nothing — which made
  // the "both spellings answer the same question" clause compare [] with [] and pass without
  // asking anything. Found by adding the non-vacuity guard that clause now carries.
  //
  // So the final RECENT_ROWS rows are dated relative to the RUN, half inside the window and
  // half outside it, with the hot agent and `model_call` among them. The window now has a
  // real inside and a real outside, which is what makes an equality between two spellings of
  // it evidence. The year-long body is untouched: it is what makes the PLAN honest at scale.
  const RECENT_ROWS = 2_000;
  const now = Date.now();
  d.transaction(() => {
    for (let i = 0; i < AUDIT_ROWS; i++) {
      const agent = i % 4 === 0 ? HOT_AGENT : ids[i % AGENTS];
      const recent = i >= AUDIT_ROWS - RECENT_ROWS;
      const ms = recent
        // Even offsets land 1 minute to ~8 hours back (INSIDE the 24h window); odd offsets
        // land 2 to ~30 days back (OUTSIDE it), so neither side of the bound is empty.
        ? now - ((i % 2 === 0) ? (1 + (i % 480)) * 60_000 : (2 + (i % 28)) * 86_400_000)
        : start + i * 60_000;
      const at = new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
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
