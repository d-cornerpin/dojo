// ════════════════════════════════════════════════════════════════════════════════════════
// A NULL ID SILENCES A SWEEP, AND MIGRATION 180 IS THE SWEEP ASKED SAFELY (W2-B item G).
//
// ── THE BACKLOG LINE, AND WHAT IT IS ACTUALLY ABOUT ──
// "the residue sweep's `NOT IN` safety rests on 'no writer inserts a NULL id', not on the
// schema". The sweep is `175_orphaned_embeddings.sql`, and its four statements are
// `source_id NOT IN (SELECT id FROM <messages|summaries|techniques|briefings>)`. Those four
// `id` columns are a bare `id TEXT PRIMARY KEY`, and SQLite's PRIMARY KEY does NOT imply NOT
// NULL outside a STRICT table — none of these are STRICT. Measured at this head, THREE of the
// four are exposed, and the backlog line names exactly those three:
//
//   messages.id    notnull=1   PROTECTED — the 127/131/132/133 rebuilds made it NOT NULL
//   summaries.id   notnull=0   EXPOSED
//   techniques.id  notnull=0   EXPOSED
//   briefings.id   notnull=0   EXPOSED
//
// The `messages` row is the useful precedent, and the reason the guard below is a PREDICATE and
// not a schema change: NOT NULL arrived there as a SIDE EFFECT of a rebuild done for other
// reasons, which is the only way this tree has ever paid for one.
//
// ── WHY IT IS THE QUIET DIRECTION ──
// `x NOT IN (SELECT id FROM t)` is `NOT (x = id1 OR x = id2 OR …)`. One NULL makes every
// comparison UNKNOWN, so the predicate is UNKNOWN for EVERY row and the DELETE removes
// nothing. It never eats a row it should keep; it silently KEEPS rows it should eat. And 175
// is a one-shot, so on a box that held a NULL id when it ran, that lane reported success,
// cleaned nothing, and nothing will retry it.
//
// Rehearsed on a `VACUUM INTO` copy of an adversarial fixture (a NULL id planted in all four
// source tables, two in `summaries` because a PRIMARY KEY does not dedupe NULLs either, plus
// correct rows that must survive): 175's spelling deleted 0 of 5 doomed rows. 180's deleted
// 5 of 5, kept all 4 live rows, and kept the unknown-kind row.
//
// ── WHY NOT A `CHECK (id IS NOT NULL)`, WHICH THE BRIEF OFFERS AS THE OTHER ROAD ──
// Because the exposure is not three tables. Censused from the migrated schema and asserted
// below: FORTY-TWO tables declare a nullable `id TEXT PRIMARY KEY`, including `work`, `agents`,
// `audit_log`, `deliveries` and `conversations`. A CHECK needs a full table rebuild, which is
// the highest-ceremony migration shape here (`138` and `142` show the cost for ONE table), and
// the entire damage class is "a sweep silently does nothing" — never a lost row. Forty-two
// rebuilds is the wrong trade.
//
// The guard that actually closes it is free: the PREDICATE. `176`, written days after `175`,
// already chose `NOT EXISTS` deliberately and said why. So this file censuses every
// `NOT IN (SELECT …)` site in the tree against a pinned list — a new one fails before it can
// ship — and pins the nullability of all four columns, so the day one of the three gains a
// CHECK or its table becomes STRICT, the clause says the exposure is gone rather than going
// quietly stale.
//
// All rows and names below are fictional.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-null-id-sweep');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-null-id-sweep', 'dojo.db'),
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
const n = (sql: string, ...a: unknown[]): number => (db().prepare(sql).get(...a) as { n: number }).n;

/** The four lanes `175`/`180` sweep, and the column each subquery reads. */
const LANES = [
  { kind: 'message', table: 'messages' },
  { kind: 'summary', table: 'summaries' },
  { kind: 'technique', table: 'techniques' },
  { kind: 'briefing', table: 'briefings' },
] as const;

const MIGRATION = '180_embedding_sweep_without_not_in.sql';
const MIG_DIR = path.resolve(__dirname, '../migrations');

/** Every statement of the migration, as the chain runner would see them. */
const statementsOf = (file: string): string[] =>
  fs.readFileSync(path.join(MIG_DIR, file), 'utf-8')
    .split('\n').map(l => { const i = l.indexOf('--'); return i < 0 ? l : l.slice(0, i); })
    .join('\n').split(';').map(s => s.trim()).filter(s => s.length > 0);

/** `summaries.agent_id` and `briefings.agent_id` are foreign keys into `agents`, so the
 *  adversarial body needs a real agent to hang off. All fictional. */
const seedAgent = (): void => {
  const d = db();
  d.prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
             VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                                 max_output_tokens, is_enabled, created_at, updated_at)
             VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  d.prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
             VALUES ('a1','a1','m1','idle','{}',1,'owner',datetime('now'),datetime('now'))`).run();
};

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  await runMigrations();
  seedAgent();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── THE EXPOSURE, ON THE REAL SCHEMA ─────────────────────────────────────────────────────

describe('the exposure the backlog line names, measured on the migrated schema', () => {
  it('⚠ three of the four source tables declare `id` NULLABLE — and `messages` is the control', () => {
    const nullability: Record<string, number> = {};
    for (const { table } of LANES) {
      const col = (db().prepare(`PRAGMA table_info("${table}")`).all() as
        Array<{ name: string; notnull: number }>).find(c => c.name === 'id');
      expect(col, `${table} has no id column`).toBeDefined();
      nullability[table] = col!.notnull;
    }
    // Pinned as a MAP rather than a loop, so a change in EITHER direction is visible: the day
    // one of the three gains NOT NULL that exposure is gone and this clause says so; the day
    // `messages` loses it, the largest lane is exposed and this clause says that too.
    expect(nullability).toEqual({
      messages: 1,      // PROTECTED by its rebuilds — the precedent, not the hazard
      summaries: 0,     // the three the backlog line names, measured
      techniques: 0,
      briefings: 0,
    });
  });

  it('⚠ a NULL id is ACCEPTED, and so is a SECOND one — a PK does not dedupe NULLs', () => {
    db().prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (NULL, ?, ?, ?)')
      .run('first with no id', 'draft', '/tmp/a');
    db().prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (NULL, ?, ?, ?)')
      .run('second with no id', 'draft', '/tmp/b');
    expect(n('SELECT COUNT(*) AS n FROM techniques WHERE id IS NULL')).toBe(2);
  });

  it('⚠ `NOT IN` sweeps NOTHING once a NULL is in the subquery; `NOT EXISTS` sweeps correctly', () => {
    db().prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (?, ?, ?, ?)')
      .run('t-live', 'a kept technique', 'published', '/tmp/live');
    db().prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (NULL, ?, ?, ?)')
      .run('the poison row', 'draft', '/tmp/null');
    const ins = db().prepare(
      'INSERT INTO embeddings (id, source_type, source_id, embedding, dimensions) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run('e-gone', 'technique', 't-gone', Buffer.from([0]), 4);
    ins.run('e-live', 'technique', 't-live', Buffer.from([0]), 4);

    // 175's spelling, verbatim in shape.
    const notIn = db().prepare(
      "DELETE FROM embeddings WHERE source_type = 'technique' AND source_id NOT IN (SELECT id FROM techniques)",
    ).run();
    expect(notIn.changes, 'this is the silent no-op the whole item is about').toBe(0);

    // 180's spelling, over the identical body.
    const notExists = db().prepare(
      "DELETE FROM embeddings WHERE source_type = 'technique' AND NOT EXISTS (SELECT 1 FROM techniques s WHERE s.id = embeddings.source_id)",
    ).run();
    expect(notExists.changes).toBe(1);
    expect(n('SELECT COUNT(*) AS n FROM embeddings WHERE id = ?', 'e-live')).toBe(1);
  });

  it('the exposure is TREE-WIDE, which is why no CHECK migration ships — measured', () => {
    const tables = (db().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map(r => r.name);
    const bare: string[] = [];
    for (const t of tables) {
      const col = (db().prepare(`PRAGMA table_info("${t}")`).all() as
        Array<{ name: string; type: string; notnull: number; pk: number }>).find(c => c.name === 'id');
      if (col && col.pk > 0 && col.notnull === 0 && /TEXT/i.test(col.type)) bare.push(t);
    }
    // Not three tables. The number IS the argument against a CHECK: forty-two rebuilds, to
    // defend a failure mode whose whole damage is a silenced sweep, is the wrong trade.
    expect(bare.length).toBeGreaterThan(35);
    // …and it is not some obscure corner: the spine's own tables are in it.
    expect(bare).toEqual(expect.arrayContaining(['work', 'agents', 'audit_log', 'conversations']));
    // `messages` is NOT, which is what makes it the precedent rather than another instance.
    expect(bare).not.toContain('messages');
  });
});

// ── MIGRATION 180, DRIVEN THROUGH THE CHAIN ──────────────────────────────────────────────

describe('migration 180 — the four lanes asked the way a NULL cannot answer for', () => {
  it('is in the chain, and every statement is a NOT EXISTS over a named kind', () => {
    const stmts = statementsOf(MIGRATION);
    expect(stmts).toHaveLength(4);
    for (const s of stmts) {
      expect(s).toMatch(/NOT EXISTS/i);
      expect(s, 'a NOT IN here would reintroduce the exact bug this file repairs')
        .not.toMatch(/NOT\s+IN/i);
      // Per kind and BY NAME — 175's rule, which stops a blanket sweep eating a new kind.
      expect(s).toMatch(/source_type\s*=\s*'(message|summary|technique|briefing)'/);
    }
  });

  it('⚠ sweeps every doomed row on an ADVERSARIAL body and keeps every correct one', () => {
    const d = db();
    // A NULL id planted in the THREE tables that accept one — the state that silenced 175.
    // `messages` is deliberately not among them: it REFUSES a NULL id, asserted here rather
    // than assumed, so this fixture cannot quietly stop being adversarial.
    expect(() => d.prepare('INSERT INTO messages (id, agent_id, role, content, lane, created_at) VALUES (NULL,?,?,?,?,?)')
      .run('a1', 'user', 'no id', 'owner', Date.now())).toThrow(/NOT NULL constraint failed/);
    d.prepare('INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at) VALUES (NULL,?,?,?,?,?,?,?)')
      .run('a1', 1, 'condensed', 'no id', 1, 'now', 'now');
    d.prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (NULL,?,?,?)')
      .run('no id', 'draft', '/tmp/n');
    d.prepare('INSERT INTO briefings (id, agent_id, content, token_count) VALUES (NULL,?,?,?)')
      .run('a1', 'no id', 1);
    // Correct rows that MUST survive.
    d.prepare('INSERT INTO messages (id, agent_id, role, content, lane, created_at) VALUES (?,?,?,?,?,?)')
      .run('m-live', 'a1', 'user', 'hello', 'owner', Date.now());
    d.prepare('INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, earliest_at, latest_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('s-live', 'a1', 1, 'condensed', 'sum', 1, 'now', 'now');
    d.prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (?,?,?,?)')
      .run('t-live', 'kept', 'published', '/tmp/l');
    d.prepare('INSERT INTO briefings (id, agent_id, content, token_count) VALUES (?,?,?,?)')
      .run('b-live', 'a1', 'kept', 1);

    const ins = d.prepare(
      'INSERT INTO embeddings (id, source_type, source_id, embedding, dimensions) VALUES (?,?,?,?,?)',
    );
    for (const { kind } of LANES) {
      ins.run(`gone-${kind}`, kind, `${kind[0]}-gone`, Buffer.from([0]), 4);
      ins.run(`live-${kind}`, kind, `${kind[0]}-live`, Buffer.from([0]), 4);
    }
    // Two embeddings naming the SAME dead source, and an UNKNOWN kind that must survive.
    ins.run('gone-message-2', 'message', 'm-gone', Buffer.from([0]), 4);
    ins.run('unknown-kind', 'vault_entry', 'v-gone', Buffer.from([0]), 4);

    for (const s of statementsOf(MIGRATION)) d.prepare(s).run();

    expect((d.prepare('SELECT id FROM embeddings ORDER BY id').all() as Array<{ id: string }>)
      .map(r => r.id)).toEqual([
      'live-briefing', 'live-message', 'live-summary', 'live-technique', 'unknown-kind',
    ]);
    // The source rows are not this file's business — it deletes no source row, NULL or not.
    expect(n('SELECT COUNT(*) AS n FROM techniques WHERE id IS NULL')).toBe(1);
  });

  it('is IDEMPOTENT by its predicates — a second application changes nothing', () => {
    const d = db();
    d.prepare('INSERT INTO techniques (id, name, state, directory_path) VALUES (?,?,?,?)')
      .run('t-live', 'kept', 'published', '/tmp/l');
    const ins = d.prepare(
      'INSERT INTO embeddings (id, source_type, source_id, embedding, dimensions) VALUES (?,?,?,?,?)',
    );
    ins.run('gone', 'technique', 't-gone', Buffer.from([0]), 4);
    ins.run('live', 'technique', 't-live', Buffer.from([0]), 4);

    const stmts = statementsOf(MIGRATION);
    const firstPass = stmts.reduce((acc, s) => acc + d.prepare(s).run().changes, 0);
    expect(firstPass).toBe(1);
    const secondPass = stmts.reduce((acc, s) => acc + d.prepare(s).run().changes, 0);
    expect(secondPass).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM embeddings')).toBe(1);
  });

  it('is correct on a FRESH install — all four against empty tables', () => {
    for (const s of statementsOf(MIGRATION)) expect(() => db().prepare(s).run()).not.toThrow();
    expect(n('SELECT COUNT(*) AS n FROM embeddings')).toBe(0);
  });
});

// ── THE TRIPWIRE: NO NEW `NOT IN (SELECT …)` SITE SHIPS UNARGUED ─────────────────────────

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue;
      walk(fp, acc);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.sql')) acc.push(fp);
  }
  return acc;
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

/** Comments blanked — SQL `--` and TypeScript both — so prose about `NOT IN` is not a site. */
const stripComments = (s: string): string => s
  .split('\n').map(l => { const i = l.indexOf('--'); return i < 0 ? l : l.slice(0, i); }).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

const NOT_IN_SUBQUERY = /NOT\s+IN\s*\(\s*SELECT/gi;

function notInSites(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of walk(SRC)) {
    const m = stripComments(fs.readFileSync(f, 'utf-8')).match(NOT_IN_SUBQUERY);
    if (m) out[rel(f)] = m.length;
  }
  return out;
}

/**
 * Every `NOT IN (SELECT …)` in the tree, with its count. All of these are APPLIED one-shot
 * migrations or reads over a NOT NULL column; an applied migration may never be edited, which
 * is why `180` repairs `175` rather than fixing it in place. A NEW entry — or a changed count
 * — fails this clause, and the fix is `NOT EXISTS` unless the subquery column is NOT NULL and
 * the commit says so.
 */
const DECLARED_NOT_IN: Record<string, number> = {
  'db/migrations/081_fts_sync_and_orphan_cleanup.sql': 1,
  'db/migrations/098_inter_agent_messages.sql': 1,
  'db/migrations/129b_stable_merge_messages.sql': 22,
  'db/migrations/175_orphaned_embeddings.sql': 4,
  'memory/compaction.ts': 1,
  'memory/condense-until-fits.ts': 1,
  'memory/dag.ts': 1,
  'router/head.ts': 1,
};

describe('the `NOT IN (SELECT …)` census — a new site cannot ship unnoticed', () => {
  it('the matcher is not blind: it sees a real site and ignores a described one', () => {
    expect(NOT_IN_SUBQUERY.test(stripComments('WHERE id NOT IN (SELECT id FROM t)'))).toBe(true);
    expect(NOT_IN_SUBQUERY.test(stripComments('-- id NOT IN (SELECT id FROM t) is the bug'))).toBe(false);
    expect(NOT_IN_SUBQUERY.test(stripComments('// NOT IN (SELECT …) — described, never run'))).toBe(false);
    // A literal list is not the hazard; only a subquery can yield a NULL nobody expected.
    expect(NOT_IN_SUBQUERY.test(stripComments("WHERE role NOT IN ('assistant','tool')"))).toBe(false);
  });

  it('⚠ names every site in the tree, so a new one — or a new count — fails here', () => {
    expect(notInSites()).toEqual(DECLARED_NOT_IN);
  });

  it('180 itself is NOT in the census, which is the point of writing it', () => {
    expect(Object.keys(notInSites())).not.toContain(`db/migrations/${MIGRATION}`);
  });
});
