// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 169 (`dojo_reports`) — THE REHEARSAL ON A LIVED-IN BODY.
//
// The update-integrity standard is binding: an update never fails, and a migration that
// refuses — or quietly damages — a body that has been in use for months is the `.23` / `135`
// incident class. Roadmap #16: every plan-supplied artefact is rehearsed against reality
// before it is trusted, and for a migration that means BODIES.
//
// 169 is the easiest shape in the chain to get right and the easiest to be lazy about: a
// bare `CREATE TABLE IF NOT EXISTS` on a name that appears nowhere else in the 171-file
// chain. "Obviously safe" is exactly the claim this file exists to stop anyone making
// without evidence, because the two ways it could stop being true — the name colliding with
// something a future file creates, and the `IF NOT EXISTS` being dropped in an edit — are
// both invisible until a real box refuses to boot.
//
// BODY A  a fresh install        — the table and both indexes arrive, and it arrives EMPTY
// BODY B  a LIVED-IN stable body — every pre-existing row survives byte-for-byte
// BODY C  RE-RUN                 — the chain is idempotent; a second and third boot change nothing
// BODY D  THE INDEXES            — both exist, named as declared, on the columns the readers filter by
// NEGATIVE CONTROL               — a body that ALREADY carries the table, with a row in it,
//                                  takes the migration and keeps the row
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-169');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-169', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_169 = '169_dojo_reports.sql';
const NEW_TABLE = 'dojo_reports';
const NEW_INDEXES = ['idx_dojo_reports_status', 'idx_dojo_reports_signature'];

const db = (): Database.Database => mockDb.current!;

const tableExists = (name: string): boolean =>
  db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const reportColumns = (): string[] =>
  (db().prepare(`PRAGMA table_info(${NEW_TABLE})`).all() as Array<{ name: string }>).map(r => r.name);

const indexSql = (name: string): string | undefined =>
  (db().prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as
    { sql: string } | undefined)?.sql;

/** Put a fully-migrated body back into the state a v3.1.28 box carries. */
const rewindTo168 = (): void => {
  db().exec(`DROP TABLE IF EXISTS ${NEW_TABLE};`); // its indexes go with it
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_169);
};

/** The rows a box that has been in use actually holds. */
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
  d.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{"tone":"dry"}', '2026-07-02 09:00:00', '2026-09-01 09:00:00')
  `).run();

  // The work spine, written the way the engine writes it: epoch-ms times, no defaults taken,
  // `closed_at` paired with a terminal state (135's paired CHECK) and `abandoned` rather than
  // `done` for the closed ones, because 139's two-key rule makes `done` unreachable without a
  // delivery row. Writing it any other way would be seeding a body the engine cannot produce.
  const work = d.prepare(`
    INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes,
                      closes_thread, title, opened_at, updated_at, closed_at)
    VALUES (?, ?, 'kevin', 'owner', 'conversation', 'c-1', ?, 'ANSWER', 1, 1, ?, ?, ?, ?)
  `);
  const DAY_MS = 86_400_000;
  for (let i = 0; i < 12; i++) {
    const at = Date.now() - i * DAY_MS;
    const closed = i % 3 === 0;
    work.run(`w-${i}`, i % 2 === 0 ? 'task' : 'ask', closed ? 'abandoned' : 'open',
      `piece ${i}`, at, at, closed ? at + 1_000 : null);
  }

  const cost = d.prepare(`
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                              cost_usd, latency_ms, created_at)
    VALUES (?, 'kevin', 'm-local', 'local', ?, ?, 0.0, ?, datetime('now', ?))
  `);
  for (let i = 0; i < 30; i++) cost.run(`cost-${i}`, 3_000 + i * 700, 200 + i, 40_000 + i * 1_000, `-${i} days`);
};

/** Everything that must be identical on the far side, as one comparable snapshot. */
const snapshot = (): Record<string, unknown> => ({
  providers: db().prepare('SELECT * FROM providers ORDER BY id').all(),
  models: db().prepare('SELECT * FROM models ORDER BY id').all(),
  agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
  work: db().prepare('SELECT * FROM work ORDER BY id').all(),
  costRecords: db().prepare('SELECT * FROM cost_records ORDER BY id').all(),
});

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('BODY A — a fresh install', () => {
  it('the chain leaves the table present, with every declared column', () => {
    expect(tableExists(NEW_TABLE)).toBe(true);
    expect(reportColumns().sort()).toEqual([
      'agent_id', 'approved_at', 'brief_json', 'bundle_path', 'created_at', 'export_path', 'id',
      'issue_number', 'issue_url', 'lane', 'posted_at', 'signature', 'status', 'telemetry_json',
      'updated_at',
    ]);
  });

  it('and it arrives EMPTY, which is correct: a fresh box has filed no reports', () => {
    expect(db().prepare(`SELECT COUNT(*) AS n FROM ${NEW_TABLE}`).get()).toEqual({ n: 0 });
  });

  it('a row takes the defaults the store relies on — drafting, and two stamps', () => {
    db().prepare(`INSERT INTO ${NEW_TABLE} (id, agent_id, lane, signature) VALUES (?, ?, ?, ?)`)
      .run('r-1', 'kevin', 'tool-error', 'ds1-aaaaaaaaaaaa');
    const row = db().prepare(
      `SELECT status, created_at AS c, updated_at AS u, approved_at AS a, posted_at AS p,
              brief_json AS b, telemetry_json AS t, bundle_path AS bp, export_path AS ep,
              issue_url AS iu, issue_number AS inum
         FROM ${NEW_TABLE} WHERE id = 'r-1'`,
    ).get() as Record<string, unknown>;
    expect(row.status).toBe('drafting');
    expect(row.c).toBeTruthy();
    expect(row.u).toBeTruthy();
    // Everything a report has not done yet is NULL, not a fabricated value.
    for (const k of ['a', 'p', 'b', 't', 'bp', 'ep', 'iu', 'inum']) expect(row[k]).toBeNull();
  });

  it('there is NO CHECK on `status` — the legal set lives in report/store.ts, once', () => {
    // Deliberate, and argued in the migration header: a CHECK here would be a second, staler
    // copy of `ReportStatus`, and the reader must SURVIVE a value this schema never approved
    // rather than trust a constraint to have held.
    expect(() => db().prepare(
      `INSERT INTO ${NEW_TABLE} (id, agent_id, lane, signature, status) VALUES (?, ?, ?, ?, ?)`,
    ).run('r-2', 'kevin', 'tool-error', 'ds1-bbbbbbbbbbbb', 'sideways')).not.toThrow();
  });

  it('recorded itself in `_migrations`, so a second boot does not re-run it', () => {
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_169))
      .toEqual({ n: 1 });
  });
});

describe('BODY B — A LIVED-IN STABLE BODY (the one that decides the entry)', () => {
  it('⚠ APPLIES WITHOUT RAISING — a migration that refuses a lived-in body refuses the BOOT', () => {
    rewindTo168();
    fillLivedIn();
    expect(() => runMigrations()).not.toThrow();
  });

  it('the table arrives and is EMPTY on a box that has been in use for months', () => {
    rewindTo168();
    fillLivedIn();
    expect(tableExists(NEW_TABLE)).toBe(false);
    runMigrations();
    expect(tableExists(NEW_TABLE)).toBe(true);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM ${NEW_TABLE}`).get()).toEqual({ n: 0 });
  });

  it('NO DATA LOSS — every pre-existing row is byte-for-byte what it was', () => {
    rewindTo168();
    fillLivedIn();
    const before = snapshot();
    runMigrations();
    expect(snapshot()).toEqual(before);
  });

  it('and the row COUNTS are identical, stated separately because a count is what a person checks', () => {
    rewindTo168();
    fillLivedIn();
    const count = (t: string): number =>
      (db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = { agents: count('agents'), work: count('work'), costRecords: count('cost_records') };
    runMigrations();
    expect({ agents: count('agents'), work: count('work'), costRecords: count('cost_records') })
      .toEqual(before);
    expect(before.work).toBe(12);
    expect(before.costRecords).toBe(30);
  });
});

describe('BODY C — THE RE-RUN', () => {
  it('a second boot over the same body changes nothing at all', () => {
    rewindTo168();
    fillLivedIn();
    runMigrations();
    const after1 = snapshot();
    const migrations1 = db().prepare('SELECT name FROM _migrations ORDER BY name').all();
    expect(() => runMigrations()).not.toThrow();
    expect(snapshot()).toEqual(after1);
    expect(db().prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual(migrations1);
  });

  it('a THIRD boot too — idempotence is not a one-shot property', () => {
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_169))
      .toEqual({ n: 1 });
  });

  it('the FILE itself applies twice — `IF NOT EXISTS` is the property, not the `_migrations` row', () => {
    // The marker row alone would hide a bare `CREATE TABLE`: the chain would never re-run it,
    // and the defect would surface only on a box whose marker was lost with a restored backup.
    const sql = db().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(NEW_TABLE) as { sql: string };
    expect(sql.sql).toContain('dojo_reports');
    rewindTo168();
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
    expect(tableExists(NEW_TABLE)).toBe(true);
  });
});

describe('BODY D — THE INDEXES the card and the dedupe need', () => {
  it('both exist and are named as declared', () => {
    for (const name of NEW_INDEXES) {
      expect(indexSql(name), `${name} is what keeps the preview card off a full scan`).toBeDefined();
    }
  });

  it('the status index is the one `listOpenReports` filters and orders by', () => {
    expect(indexSql('idx_dojo_reports_status')).toContain('status');
    expect(indexSql('idx_dojo_reports_status')).toContain('created_at');
  });

  it('the signature index is the one the dedupe search reads', () => {
    expect(indexSql('idx_dojo_reports_signature')).toContain('signature');
  });

  it('SQLite actually USES the status index for the list shape', () => {
    const plan = db().prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM ${NEW_TABLE} WHERE status = ? ORDER BY created_at DESC
    `).all('awaiting_approval') as Array<{ detail: string }>;
    expect(plan.map(r => r.detail).join(' ')).toContain('idx_dojo_reports_status');
  });
});

describe('NEGATIVE CONTROL — a body that already carries the table', () => {
  it('keeps the row it already had; the migration is not a rewrite', () => {
    // The only shape in which this file could destroy data: a `DROP TABLE` or a
    // `CREATE TABLE` without `IF NOT EXISTS` reaching a body that already has reports in it
    // (a box whose `_migrations` marker was lost with a restored backup).
    db().prepare(`
      INSERT INTO ${NEW_TABLE} (id, agent_id, status, lane, signature, brief_json, issue_number)
      VALUES ('r-old', 'kevin', 'posted', 'tool-error', 'ds1-cccccccccccc', '{"title":"kept"}', 42)
    `).run();
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_169);

    expect(() => runMigrations()).not.toThrow();

    expect(db().prepare(
      `SELECT id, status, signature, brief_json AS b, issue_number AS n FROM ${NEW_TABLE}`,
    ).all()).toEqual([
      { id: 'r-old', status: 'posted', signature: 'ds1-cccccccccccc', b: '{"title":"kept"}', n: 42 },
    ]);
  });

  it('and both indexes survive the second application', () => {
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_169);
    runMigrations();
    for (const name of NEW_INDEXES) expect(indexSql(name)).toBeDefined();
  });
});
