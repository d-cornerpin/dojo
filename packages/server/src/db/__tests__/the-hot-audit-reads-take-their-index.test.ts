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
// ── THE FINDING, HANDED UP BY W2-B AND FIXED BY t112 (2026-10-05) ──
// What follows is the finding as it was written. It is CLOSED: `gateway/routes/tracker.ts`
// now compares the raw column, the clauses below read the route's own SQL rather than a copy,
// and the wrapped spelling survives as the NEGATIVE CONTROL — derived from the route's bytes
// by putting the wrapper back, so a regression is a named red here instead of a slow dashboard
// nobody attributes. The original text:
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
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-grown-audit');
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

// ── THE TWO HOT READS, VERBATIM FROM THE SOURCE THEY MEASURE ─────────────────────────────

/** `report/collect.ts`'s `readAudit` — the report gather's read, the one the line names. */
const REPORT_GATHER = `
  SELECT action_type, target, result, detail, call_id, created_at
    FROM audit_log WHERE agent_id = ? AND created_at >= ?
   ORDER BY created_at DESC, id DESC LIMIT 200`;

/**
 * `gateway/routes/tracker.ts`'s PM-cost read — READ OUT OF THE ROUTE, not retyped here.
 *
 * (t112, 2026-10-05) It was retyped, and it had to be while the finding was a hand-up: the
 * clause's job was to PIN the wrapped plan so the hand-up was a measured claim. Now the
 * route is fixed, and a retyped copy would go on proving things about a string this file
 * owns — it would stay green if somebody put the `datetime()` wrapper back, which is the
 * one event these clauses exist to catch. So the SQL comes from the route's bytes. If the
 * read moves or is rewritten past recognition this throws, loudly, rather than measuring a
 * query nothing runs.
 */
function dashboardPmCostSql(): string {
  const route = fs.readFileSync(
    path.join(__dirname, '..', '..', 'gateway', 'routes', 'tracker.ts'), 'utf8',
  );
  // The PM-cost read is the one template literal selecting `cost_24h` out of `audit_log`.
  const m = route.match(/`(\s*SELECT[^`]*?cost_24h[^`]*?FROM audit_log[^`]*?)`/);
  if (!m) {
    throw new Error(
      'gateway/routes/tracker.ts no longer carries a recognisable `cost_24h` read of audit_log. '
      + 'These clauses measure the ROUTE\'s query; with nothing to extract they would measure a '
      + 'string this test file invented. Re-point the extraction at wherever that read now lives.',
    );
  }
  return m[1];
}

/** The route's read as it stands — the sargable spelling, after t112. */
const DASHBOARD_PM_COST = dashboardPmCostSql();

/**
 * THE NEGATIVE CONTROL, and the shape the route used to carry: the same question with the
 * indexed column wrapped. Derived from the route's own bytes by putting the wrapper BACK, so
 * the two spellings cannot drift apart in anything but the wrapper.
 */
const DASHBOARD_WRAPPED = DASHBOARD_PM_COST.replace(
  "created_at > datetime('now', '-1 day')",
  "datetime(created_at) > datetime('now', '-1 day')",
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

// ── THE DASHBOARD: TODAY'S PLAN PINNED, AND THE SARGABLE SPELLING MEASURED BESIDE IT ─────

describe('the dashboard’s PM-cost read — the route compares the RAW indexed column', () => {
  it('the route\'s own SQL does not wrap `created_at` in a function', () => {
    // The vacuity guard for everything below: these clauses measure the route's bytes, so
    // the first thing to say is that the extraction found the read and the read is the
    // sargable spelling. A wrapper put back here fails this clause by name.
    expect(DASHBOARD_PM_COST).toContain('FROM audit_log');
    expect(DASHBOARD_PM_COST).toMatch(/created_at > datetime\('now', '-1 day'\)/);
    expect(DASHBOARD_PM_COST).not.toMatch(/datetime\(created_at\)/);
    // …and the control really is the other spelling, or the comparison below is vacuous.
    expect(DASHBOARD_WRAPPED).toMatch(/datetime\(created_at\)/);
    expect(DASHBOARD_WRAPPED).not.toEqual(DASHBOARD_PM_COST);
  });

  it('seeks BOTH halves of the composite at 200,000 rows', () => {
    const plan = planOf(DASHBOARD_PM_COST, HOT_AGENT);
    expect(plan).toContain(AUDIT_INDEX);
    expect(plan).toMatch(/created_at>\?/);
    measurements.push(`dashboard PM-cost (route, sargable)  : ${plan}`);
  });

  it('⚠ NEGATIVE CONTROL: wrapping the column loses the range seek — the defect t112 closed', () => {
    const plan = planOf(DASHBOARD_WRAPPED, HOT_AGENT);
    // It still takes an index — the agent seek is real and is the expensive half.
    expect(plan).toMatch(new RegExp(`${AUDIT_INDEX}|idx_audit_log_agent_id`));
    // …but NOT on the second leg. `datetime(created_at)` is not a column reference, so no
    // `created_at>?` can appear in the seek. This is what the route used to do.
    expect(plan).not.toMatch(/created_at>\?/);
    measurements.push(`dashboard PM-cost (datetime-wrapped) : ${plan}`);

    const wrapped = timeOf(DASHBOARD_WRAPPED, [HOT_AGENT]);
    const sargable = timeOf(DASHBOARD_PM_COST, [HOT_AGENT]);
    measurements.push(
      `dashboard timing: wrapped ${wrapped.toFixed(2)} ms/call, sargable ${sargable.toFixed(2)} ms/call `
      + `(mean of 20; wall clock on a shared box, reported not asserted)`,
    );
  });

  // ── THE PREMISE THE ROUTE'S FIX RESTS ON, COUNTED BOTH WAYS ────────────────────────────
  // A raw text compare against `datetime('now','-1 day')` is the identical question ONLY
  // while every row in this column holds the SQLite form `YYYY-MM-DD HH:MM:SS`. JavaScript's
  // `toISOString()` writes `YYYY-MM-DDTHH:MM:SS.sssZ`, and `T` (0x54) sorts above a space
  // (0x20) — so ONE writer switching to it would make rows from earlier the same day read as
  // newer than the bound and silently join a 24h rollup they do not belong to.
  // `deploy/checks/check-iso-writes.mjs` watches that family tree-wide, but it is declared
  // LOG-ONLY and never fails a build, so nothing was BINDING the premise for this column.
  //
  // Counted both ways on purpose: a clause that only checked the seven writers known today
  // would stay green when an eighth arrived, and a clause that only counted writers would
  // stay green if they all changed format. This asserts the floor AND the format of every
  // one it finds, so a NEW audit_log writer in any shape is a red here until it is read.
  it('every audit_log writer supplies `datetime(\'now\')` — the ordering the raw compare needs', () => {
    const SRC = path.resolve(__dirname, '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full); }
        else if (e.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(SRC);

    const offenders: string[] = [];
    let writers = 0;
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      // Each INSERT and the statement that follows it, far enough to carry its VALUES list.
      for (const m of text.matchAll(/INSERT\s+INTO\s+audit_log\s*\(([^)]*)\)/gi)) {
        const cols = m[1];
        if (!/\bcreated_at\b/.test(cols)) continue;
        writers += 1;
        // The statement runs to the end of its template literal — closing the slice on the
        // next backtick rather than on a paren, because `datetime('now')` carries parens of
        // its own and a paren-balanced match stops one character early inside it.
        const from = m.index ?? 0;
        const close = text.indexOf('`', from);
        const stmt = text.slice(from, close === -1 ? from + 800 : close);
        const rel = path.relative(SRC, f);
        const values = stmt.match(/VALUES\s*\(([\s\S]*)$/i);
        if (!values) { offenders.push(`${rel}: an audit_log INSERT naming created_at with no readable VALUES list`); continue; }
        if (!/datetime\('now'\)/.test(values[1])) {
          offenders.push(`${rel}: created_at is not supplied as datetime('now') — ${values[1].trim().slice(0, 120)}`);
        }
      }
    }

    // Vacuity floor: if the walk stops finding writers, the clause above proves nothing.
    expect(writers, 'no audit_log INSERT naming created_at was found — the scan has gone blind').toBeGreaterThanOrEqual(7);
    expect(
      offenders,
      'an audit_log writer supplies created_at in some other format. `gateway/routes/tracker.ts`'
      + ' compares that column RAW against datetime(\'now\',\'-1 day\'), which is only the same'
      + ' question while every row holds the SQLite YYYY-MM-DD HH:MM:SS form:\n'
      + offenders.join('\n'),
    ).toEqual([]);
    measurements.push(`audit_log writers naming created_at: ${writers}, all datetime('now')`);
  });

  it('both spellings answer the same question — a faster plan that lies is not a win', () => {
    // The equivalence the route's fix RESTS ON: every writer into this table supplies
    // `datetime('now')`, so the stored text is already lexicographically ordered and a raw
    // compare against a bound in that same format is the identical question. Asserted on
    // 200,000 generated rows rather than argued.
    const a = db().prepare(DASHBOARD_WRAPPED).all(HOT_AGENT);
    const b = db().prepare(DASHBOARD_PM_COST).all(HOT_AGENT);
    expect(b).toEqual(a);
    expect((b as unknown[]).length).toBeGreaterThan(0);
  });
});
