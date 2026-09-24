// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 170 (`github_account`) — THE REHEARSAL ON A LIVED-IN BODY.
//
// The update-integrity standard is binding: an update never fails, and a migration that
// refuses — or quietly damages — a body that has been in use for months is the `.23` / `135`
// incident class. Roadmap #16: every plan-supplied artefact is rehearsed against reality
// before it is trusted, and for a migration that means BODIES.
//
// 170 is the same easy shape as 169 and the same easy shape to be lazy about: a bare
// `CREATE TABLE IF NOT EXISTS` on a name that appears nowhere else in the chain. "Obviously
// safe" is exactly the claim this file exists to stop anyone making without evidence, because
// the two ways it could stop being true — the name colliding with something a future file
// creates, and the `IF NOT EXISTS` being dropped in an edit — are both invisible until a real
// box refuses to boot.
//
// It carries one thing 169 did not: a `CHECK (id = 1)`. That constraint is the shape of the
// table's whole contract — ONE GitHub account per box, so there is never a question of which
// row a reader meant — and a constraint nobody tests is a comment.
//
// BODY A  a fresh install        — the table arrives, with every declared column, and EMPTY
// BODY B  a LIVED-IN stable body — every pre-existing row survives byte-for-byte
// BODY C  RE-RUN                 — the chain is idempotent; a second and third boot change nothing
// BODY D  THE `CHECK (id = 1)`   — a second row is REFUSED; an upsert on id 1 is the only write
// NEGATIVE CONTROL               — a body that ALREADY carries a connected `github_account`
//                                  row takes the migration again and keeps the row
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-170');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-170', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_170 = '170_github_account.sql';
const NEW_TABLE = 'github_account';

const db = (): Database.Database => mockDb.current!;

const tableExists = (name: string): boolean =>
  db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const accountColumns = (): string[] =>
  (db().prepare(`PRAGMA table_info(${NEW_TABLE})`).all() as Array<{ name: string }>).map(r => r.name);

/** Put a fully-migrated body back into the state a v3.1.28 box carries. */
const rewindTo169 = (): void => {
  db().exec(`DROP TABLE IF EXISTS ${NEW_TABLE};`);
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_170);
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

  // The one table whose neighbourhood this migration is joining: a box that has already
  // connected Google carries sealed OAuth material, and 170 must not go near it.
  d.prepare(`
    INSERT INTO google_accounts (id, kind, position, email, enabled, connected,
                                 access_token, refresh_token, granted_scopes)
    VALUES ('agent', 'agent', 1, 'someone@example.test', 1, 1,
            'dojo.v1.fixture-sealed-a', 'dojo.v1.fixture-sealed-b', 'gmail.readonly')
  `).run();

  // Reports already filed under 169 — the migration that lands immediately before this one.
  const rep = d.prepare(`
    INSERT INTO dojo_reports (id, agent_id, status, lane, signature, brief_json)
    VALUES (?, 'kevin', ?, 'tool-error', ?, '{"title":"kept"}')
  `);
  rep.run('r-1', 'posted', 'ds1-aaaaaaaaaaaa');
  rep.run('r-2', 'awaiting_approval', 'ds1-bbbbbbbbbbbb');

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
  googleAccounts: db().prepare('SELECT * FROM google_accounts ORDER BY id').all(),
  dojoReports: db().prepare('SELECT * FROM dojo_reports ORDER BY id').all(),
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
    expect(accountColumns().sort()).toEqual([
      'access_token', 'connected_at', 'id', 'last_error', 'last_ok_at', 'login', 'scope', 'updated_at',
    ]);
  });

  it('and it arrives EMPTY, which is correct: a fresh box has connected nothing', () => {
    expect(db().prepare(`SELECT COUNT(*) AS n FROM ${NEW_TABLE}`).get()).toEqual({ n: 0 });
  });

  it('a row takes the one default the writer relies on — updated_at', () => {
    db().prepare(`INSERT INTO ${NEW_TABLE} (id, login) VALUES (1, 'octocat')`).run();
    const row = db().prepare(
      `SELECT login, access_token AS t, scope AS s, connected_at AS c, last_ok_at AS o,
              last_error AS e, updated_at AS u FROM ${NEW_TABLE} WHERE id = 1`,
    ).get() as Record<string, unknown>;
    expect(row.login).toBe('octocat');
    expect(row.u).toBeTruthy();
    // Everything the box has not done yet is NULL, not a fabricated value.
    for (const k of ['t', 's', 'c', 'o', 'e']) expect(row[k]).toBeNull();
  });

  it('there is NO CHECK on `scope` — the legal scope lives in device-flow.ts, once', () => {
    // Deliberate, and argued in the migration header: a CHECK here would be a second, staler
    // copy of `GITHUB_OAUTH_SCOPE`, and the reader must SURVIVE a value this schema never
    // approved — including a scope GitHub granted that we did not ask for, which is a fact to
    // SHOW the owner rather than a row to refuse.
    expect(() => db().prepare(
      `INSERT INTO ${NEW_TABLE} (id, login, scope) VALUES (1, 'octocat', 'repo')`,
    ).run()).not.toThrow();
  });

  it('recorded itself in `_migrations`, so a second boot does not re-run it', () => {
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_170))
      .toEqual({ n: 1 });
  });
});

describe('BODY B — A LIVED-IN STABLE BODY (the one that decides the entry)', () => {
  it('⚠ APPLIES WITHOUT RAISING — a migration that refuses a lived-in body refuses the BOOT', () => {
    rewindTo169();
    fillLivedIn();
    expect(() => runMigrations()).not.toThrow();
  });

  it('the table arrives and is EMPTY on a box that has been in use for months', () => {
    rewindTo169();
    fillLivedIn();
    expect(tableExists(NEW_TABLE)).toBe(false);
    runMigrations();
    expect(tableExists(NEW_TABLE)).toBe(true);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM ${NEW_TABLE}`).get()).toEqual({ n: 0 });
  });

  it('NO DATA LOSS — every pre-existing row is byte-for-byte what it was', () => {
    rewindTo169();
    fillLivedIn();
    const before = snapshot();
    runMigrations();
    expect(snapshot()).toEqual(before);
  });

  it("the OTHER table holding sealed OAuth material is not touched — 170 goes nowhere near google_accounts", () => {
    rewindTo169();
    fillLivedIn();
    const before = db().prepare('SELECT access_token, refresh_token FROM google_accounts WHERE id = ?')
      .get('agent');
    runMigrations();
    expect(db().prepare('SELECT access_token, refresh_token FROM google_accounts WHERE id = ?')
      .get('agent')).toEqual(before);
  });

  it('and the row COUNTS are identical, stated separately because a count is what a person checks', () => {
    rewindTo169();
    fillLivedIn();
    const count = (t: string): number =>
      (db().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = {
      agents: count('agents'), dojoReports: count('dojo_reports'),
      googleAccounts: count('google_accounts'), costRecords: count('cost_records'),
    };
    runMigrations();
    expect({
      agents: count('agents'), dojoReports: count('dojo_reports'),
      googleAccounts: count('google_accounts'), costRecords: count('cost_records'),
    }).toEqual(before);
    expect(before.dojoReports).toBe(2);
    expect(before.costRecords).toBe(30);
  });
});

describe('BODY C — THE RE-RUN', () => {
  it('a second boot over the same body changes nothing at all', () => {
    rewindTo169();
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
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_170))
      .toEqual({ n: 1 });
  });

  it('the FILE itself applies twice — `IF NOT EXISTS` is the property, not the `_migrations` row', () => {
    // The marker row alone would hide a bare `CREATE TABLE`: the chain would never re-run it,
    // and the defect would surface only on a box whose marker was lost with a restored backup.
    const sql = db().prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(NEW_TABLE) as { sql: string };
    expect(sql.sql).toContain(NEW_TABLE);
    expect(sql.sql).toContain('CHECK');
    rewindTo169();
    runMigrations();
    expect(() => runMigrations()).not.toThrow();
    expect(tableExists(NEW_TABLE)).toBe(true);
  });
});

describe('BODY D — `CHECK (id = 1)`, the one-account contract', () => {
  it('REFUSES a second row — there is never a question of which account a reader meant', () => {
    db().prepare(`INSERT INTO ${NEW_TABLE} (id, login) VALUES (1, 'octocat')`).run();
    expect(() => db().prepare(`INSERT INTO ${NEW_TABLE} (id, login) VALUES (2, 'hubot')`).run())
      .toThrow(/CHECK constraint failed/);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM ${NEW_TABLE}`).get()).toEqual({ n: 1 });
  });

  it('and the upsert the writer uses REPLACES rather than multiplies', () => {
    const write = db().prepare(`
      INSERT INTO ${NEW_TABLE} (id, login, access_token, scope, updated_at)
      VALUES (1, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET login = excluded.login, access_token = excluded.access_token,
        scope = excluded.scope, updated_at = datetime('now')
    `);
    write.run('octocat', 'dojo.v1.first', 'public_repo');
    write.run('hubot', 'dojo.v1.second', 'public_repo');
    expect(db().prepare(`SELECT id, login, access_token AS t FROM ${NEW_TABLE}`).all())
      .toEqual([{ id: 1, login: 'hubot', t: 'dojo.v1.second' }]);
  });
});

describe('NEGATIVE CONTROL — a body that already carries the table', () => {
  it('keeps the connected account it already had; the migration is not a rewrite', () => {
    // The only shape in which this file could destroy data: a `DROP TABLE` or a
    // `CREATE TABLE` without `IF NOT EXISTS` reaching a body that has GitHub connected
    // (a box whose `_migrations` marker was lost with a restored backup). Losing the row
    // would sign the owner out of GitHub silently on an upgrade.
    db().prepare(`
      INSERT INTO ${NEW_TABLE} (id, login, access_token, scope, connected_at, last_ok_at)
      VALUES (1, 'octocat', 'dojo.v1.fixture-sealed-token', 'public_repo',
              '2026-09-01 10:00:00', '2026-09-20 11:00:00')
    `).run();
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_170);

    expect(() => runMigrations()).not.toThrow();

    expect(db().prepare(
      `SELECT id, login, access_token AS t, scope AS s, connected_at AS c, last_ok_at AS o
         FROM ${NEW_TABLE}`,
    ).all()).toEqual([{
      id: 1, login: 'octocat', t: 'dojo.v1.fixture-sealed-token', s: 'public_repo',
      c: '2026-09-01 10:00:00', o: '2026-09-20 11:00:00',
    }]);
  });

  it('and the CHECK survives the second application', () => {
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_170);
    runMigrations();
    expect(() => db().prepare(`INSERT INTO ${NEW_TABLE} (id, login) VALUES (7, 'nope')`).run())
      .toThrow(/CHECK constraint failed/);
  });
});
