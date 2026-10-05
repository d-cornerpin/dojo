// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 171 (`idx_audit_log_agent_created`, `idx_dojo_reports_agent_id`) — THE REHEARSAL.
//
// The update-integrity standard is binding: an update never fails, and a migration that
// refuses — or quietly damages — a body that has been in use for months is the `.23` / `135`
// incident class. Roadmap #16: every plan-supplied artefact is rehearsed against reality
// before it is trusted, and for a migration that means BODIES.
//
// 171 is the easiest shape in the chain to be lazy about — two `CREATE INDEX IF NOT EXISTS`
// statements, no DDL on a table, no row touched. "Obviously safe" is exactly the claim this
// file exists to stop anyone making without evidence. An index is also the one kind of object
// whose whole VALUE is invisible to a row-count assertion: it either changes the query plan or
// it is dead weight on every INSERT. So the clauses here do BOTH jobs — they prove the two
// indexes arrive and cost the data nothing, AND they prove each one is actually CHOSEN by the
// reader it was written for, named by its own SQL.
//
// BODY A  a fresh install        — both indexes arrive, on empty tables, and the chain completes
// BODY B  a LIVED-IN stable body — every pre-existing row survives byte-for-byte
// BODY C  RE-RUN                 — the chain is idempotent; a second and third boot change nothing
// BODY D  THE PLANS              — `readAudit` stops sorting a scan and `agentHasWithdrawnReport`
//                                  stops scanning, each asserted against the reader's real SQL
// NEGATIVE CONTROL               — the indexes 169 created are still there and still chosen for
//                                  the reads they were made for, so this file WIDENED the table's
//                                  index set rather than displacing it
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-171');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-171', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_171 = '171_report_read_indexes.sql';
const AUDIT_INDEX = 'idx_audit_log_agent_created';
const REPORTS_INDEX = 'idx_dojo_reports_agent_id';

const db = (): Database.Database => mockDb.current!;

const indexExists = (name: string): boolean =>
  db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined;

const indexSql = (name: string): string =>
  (db().prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql: string }).sql;

const indexesOn = (table: string): string[] =>
  (db().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
       AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all(table) as Array<{ name: string }>).map(r => r.name);

const plan = (sql: string, ...args: unknown[]): string =>
  (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map(r => r.detail).join(' | ');

// ── THE TWO READERS, VERBATIM ────────────────────────────────────────────────────────────
// Copied from their modules rather than imported, because importing them would drag the whole
// report path (and its config, logger and window maths) into a migration test. The copies are
// load-bearing, so a drift between them and the real query is the thing to watch: if either
// module's SQL changes shape, these clauses keep passing while the index stops being used. The
// `PERMANENT GUARD` note in STABLE-BRIDGE Entry 53 names that risk.

/** `report/collect.ts` → `readAudit`. */
const READ_AUDIT = `SELECT action_type, target, result, detail, call_id, created_at
       FROM audit_log WHERE agent_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`;

/** `report/withdrawn-claim.ts` → `agentHasWithdrawnReport` (four standing statuses). */
const WITHDRAWN_GATE = `SELECT 1 AS ok FROM dojo_reports
        WHERE agent_id = ? AND status NOT IN (?, ?, ?, ?) LIMIT 1`;

/** Put a fully-migrated body back into the state a v3.2.0 box carries. */
const rewindTo170 = (): void => {
  db().exec(`DROP INDEX IF EXISTS ${AUDIT_INDEX}; DROP INDEX IF EXISTS ${REPORTS_INDEX};`);
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_171);
};

/** The rows a box that has been in use actually holds, in the two tables 171 touches. */
const fillLivedIn = (): void => {
  const d = db();
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', 'http://192.168.1.9:8000/v1', 'none', 1,
            '2026-07-01 09:00:00', '2026-09-01 09:00:00')
  `).run();
  d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-local', 'local', 'Local DS4', 'local-ds4', '["text","tools"]', 65536, 8192, 1,
            datetime('now'), datetime('now'))
  `).run();
  const agent = d.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, ?, 'm-local', 'idle', '{}', '2026-07-02 09:00:00', '2026-09-01 09:00:00')
  `);
  agent.run('zargo', 'Zargo');
  agent.run('quilba', 'Quilba');

  // An audit history with BOTH agents interleaved in time — the shape that makes a
  // single-column index insufficient, and the shape a real box has.
  const audit = d.prepare(`
    INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at)
    VALUES (?, ?, 'tool_call', ?, 'success', 'ok', ?)
  `);
  for (let i = 0; i < 400; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    audit.run(`a-${i}`, i % 2 === 0 ? 'zargo' : 'quilba', `/tmp/f-${i}`, `2026-08-${day} 10:00:00`);
  }

  // Reports filed under 169, across the standing and non-standing statuses.
  const rep = d.prepare(`
    INSERT INTO dojo_reports (id, agent_id, status, lane, signature, brief_json)
    VALUES (?, ?, ?, 'tool-error', ?, '{"title":"kept"}')
  `);
  rep.run('r-1', 'zargo', 'posted', 'ds1-aaaaaaaaaaaa');
  rep.run('r-2', 'zargo', 'awaiting_approval', 'ds1-bbbbbbbbbbbb');
  rep.run('r-3', 'quilba', 'cancelled', 'ds1-cccccccccccc');
};

const counts = (): Record<string, number> => {
  const one = (t: string): number =>
    (db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    audit_log: one('audit_log'), dojo_reports: one('dojo_reports'),
    agents: one('agents'), work: one('work'), messages: one('messages'),
  };
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── BODY A — A FRESH INSTALL ─────────────────────────────────────────────────────────────

describe('BODY A — a fresh install gets both indexes', () => {
  it('applies the whole chain and both indexes exist, named exactly', async () => {
    await runMigrations();

    expect(indexExists(AUDIT_INDEX)).toBe(true);
    expect(indexExists(REPORTS_INDEX)).toBe(true);
    // The file was RECORDED, so a second boot will not re-run it.
    expect(
      db().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(MIGRATION_171),
    ).toBeDefined();
  });

  it('indexes the columns it claims to, in the order it claims', async () => {
    await runMigrations();

    // Column ORDER is the whole design: the equality column must lead or the range on
    // `created_at` cannot be seeked. Read off the stored SQL, not assumed.
    expect(indexSql(AUDIT_INDEX).replace(/\s+/g, ' '))
      .toMatch(/ON audit_log \(agent_id, created_at\)/i);
    expect(indexSql(REPORTS_INDEX).replace(/\s+/g, ' '))
      .toMatch(/ON dojo_reports \(agent_id\)/i);
  });

  it('is correct on EMPTY tables — a fresh box has audited nothing and filed nothing', async () => {
    await runMigrations();
    expect(counts().audit_log).toBe(0);
    expect(counts().dojo_reports).toBe(0);
  });
});

// ── BODY B — A LIVED-IN BODY LOSES NOTHING ───────────────────────────────────────────────

describe('BODY B — a lived-in body keeps every row', () => {
  it('row counts and row CONTENT are identical across the migration', async () => {
    await runMigrations();
    fillLivedIn();
    rewindTo170();

    const before = counts();
    const auditBefore = db().prepare('SELECT * FROM audit_log ORDER BY id').all();
    const reportsBefore = db().prepare('SELECT * FROM dojo_reports ORDER BY id').all();
    expect(indexExists(AUDIT_INDEX)).toBe(false);

    await runMigrations();

    expect(indexExists(AUDIT_INDEX)).toBe(true);
    expect(indexExists(REPORTS_INDEX)).toBe(true);
    expect(counts()).toEqual(before);
    // Not just the count — an index build must not rewrite a value.
    expect(db().prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(auditBefore);
    expect(db().prepare('SELECT * FROM dojo_reports ORDER BY id').all()).toEqual(reportsBefore);
  });

  it('the readers still return the same rows, not merely a faster plan', async () => {
    await runMigrations();
    fillLivedIn();
    rewindTo170();

    const auditBefore = db().prepare(READ_AUDIT).all('quilba', '2026-08-01 00:00:00', 500);
    const gateBefore = db().prepare(WITHDRAWN_GATE)
      .get('quilba', 'drafting', 'awaiting_approval', 'approved', 'posted');

    await runMigrations();

    expect(db().prepare(READ_AUDIT).all('quilba', '2026-08-01 00:00:00', 500)).toEqual(auditBefore);
    expect(db().prepare(WITHDRAWN_GATE)
      .get('quilba', 'drafting', 'awaiting_approval', 'approved', 'posted')).toEqual(gateBefore);
    // …and that gate really does have something to find, or the clause proves nothing.
    expect(gateBefore).toBeDefined();
  });
});

// ── BODY C — RE-RUN ──────────────────────────────────────────────────────────────────────

describe('BODY C — re-running the chain changes nothing', () => {
  it('a second and third boot leave the schema byte-identical', async () => {
    await runMigrations();
    fillLivedIn();

    const schema = (): string =>
      JSON.stringify(db().prepare(
        "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all());

    const after1 = schema();
    const rows1 = counts();

    await runMigrations();
    await runMigrations();

    expect(schema()).toBe(after1);
    expect(counts()).toEqual(rows1);
    // Exactly one `_migrations` row for this file, however many boots happen.
    expect(
      (db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?')
        .get(MIGRATION_171) as { n: number }).n,
    ).toBe(1);
  });

  it('the raw statements are idempotent on their own — `IF NOT EXISTS` is load-bearing', async () => {
    await runMigrations();
    // Applying the two statements a second time OUTSIDE the `_migrations` bookkeeping is the
    // real test of the guard: the marker is an optimisation, the `IF NOT EXISTS` is the safety.
    expect(() => db().exec(
      `CREATE INDEX IF NOT EXISTS ${AUDIT_INDEX} ON audit_log (agent_id, created_at);
       CREATE INDEX IF NOT EXISTS ${REPORTS_INDEX} ON dojo_reports (agent_id);`,
    )).not.toThrow();
  });
});

// ── BODY D — THE PLANS, WHICH ARE THE ONLY REASON THE FILE EXISTS ────────────────────────

describe('BODY D — each index is CHOSEN by the reader it was written for', () => {
  it('`readAudit` seeks both halves instead of sorting an agent-wide scan', async () => {
    await runMigrations();
    fillLivedIn();
    rewindTo170();

    const before = plan(READ_AUDIT, 'quilba', '2026-08-01 00:00:00', 500);
    // The defect, in the planner's own words: only the agent half is seeked, and the whole
    // ORDER BY becomes a temp B-tree over every row that agent ever wrote.
    expect(before).toMatch(/idx_audit_log_agent_id/);
    expect(before).toMatch(/USE TEMP B-TREE FOR ORDER BY/);

    await runMigrations();

    const after = plan(READ_AUDIT, 'quilba', '2026-08-01 00:00:00', 500);
    expect(after).toMatch(new RegExp(AUDIT_INDEX));
    expect(after).toMatch(/created_at>/);              // the range is SEEKED, not filtered
    expect(after).not.toMatch(/USE TEMP B-TREE FOR ORDER BY\b/);  // only the `id` tiebreak is left
  });

  it('the answered-edge gate stops scanning `dojo_reports`', async () => {
    await runMigrations();
    fillLivedIn();
    rewindTo170();

    const args = ['quilba', 'drafting', 'awaiting_approval', 'approved', 'posted'] as const;
    expect(plan(WITHDRAWN_GATE, ...args)).toMatch(/SCAN dojo_reports/);

    await runMigrations();

    const after = plan(WITHDRAWN_GATE, ...args);
    expect(after).toMatch(new RegExp(`SEARCH dojo_reports USING INDEX ${REPORTS_INDEX}`));
    expect(after).not.toMatch(/SCAN dojo_reports/);
  });
});

// ── NEGATIVE CONTROL — 169's indexes are untouched and still chosen ──────────────────────

describe('NEGATIVE CONTROL — 171 widens the index set, it does not displace it', () => {
  it('keeps every index 169 and the base schema created', async () => {
    await runMigrations();

    expect(indexesOn('dojo_reports')).toEqual(
      expect.arrayContaining(['idx_dojo_reports_status', 'idx_dojo_reports_signature', REPORTS_INDEX]),
    );
    expect(indexesOn('audit_log')).toEqual(
      expect.arrayContaining(['idx_audit_log_agent_id', 'idx_audit_log_created_at', AUDIT_INDEX]),
    );
  });

  it('the preview card and the dedupe search still take THEIR indexes', async () => {
    await runMigrations();
    fillLivedIn();

    // `gateway/routes/reports.ts`' list, and `report/post.ts`' dedupe — the two reads 169's
    // indexes exist for. A new index on the same table must not have stolen them.
    expect(plan(
      'SELECT id FROM dojo_reports WHERE status = ? ORDER BY created_at', 'posted',
    )).toMatch(/idx_dojo_reports_status/);
    expect(plan(
      'SELECT id FROM dojo_reports WHERE signature = ?', 'ds1-aaaaaaaaaaaa',
    )).toMatch(/idx_dojo_reports_signature/);
  });
});
