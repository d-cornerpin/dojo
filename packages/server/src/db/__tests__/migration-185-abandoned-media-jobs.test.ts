// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 185 (abandoned media jobs) — THE REHEARSAL BODIES.
//
// The code half (`services/job-orphans.ts`, boot step 4m-0) makes an abandoned job row
// impossible from here on. This file's subject is the OTHER half: the rows already sitting on
// every upgraded box, and on every body imported from one — `gateway/routes/migration.ts`'s
// import door runs the chain inside a LIVE process whose boot reconciliation has already fired,
// so for an imported body this migration is the only repair there is.
//
// It is an UPDATE, not a DELETE, and the clauses that earn their keep are therefore the
// SURVIVORS: a predicate keyed on the wrong end of the status vocabulary would close a video
// render the provider is still working on, which is t114/U4's measured cost — `failed` is
// terminal, the boot resume skips it, the asset is never fetched, the owner is billed.
//
// BODY A  a fresh install        — applies against empty tables, changes nothing
// BODY B  a lived-in body        — the abandoned rows close; the finished, failed, cancelled and
//                                  genuinely-resumable rows are byte-for-byte untouched
// BODY C  ADVERSARIAL            — an unknown status word, a SHOUTED status word, an empty
//                                  status, an empty and a whitespace-only provider job id, a
//                                  failure carrying its own error text, and the live-shaped
//                                  video rows that MUST survive
// BODY D  RE-RUN                 — idempotent by its PREDICATE, not by the `_migrations` marker
// BODY E  A VACUUM INTO COPY     — the chain applied to a real file body, copied the way a
//                                  rehearsal copies one, then repaired on the copy (G13)
// PER-STATEMENT ROW COUNTS       — a branch that touches zero rows is an untested branch
// COUNTERFACTUAL                 — both halves of the video predicate are load-bearing: drop
//                                  the provider-job-id clause and the same body loses a live
//                                  render; drop the terminal clause and it rewrites history
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-migration-185');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-185');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-185', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_185 = '185_abandoned_media_jobs.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', MIGRATION_185), 'utf-8');
const REASON = 'abandoned at boot: no owning process';

const db = (): Database.Database => mockDb.current!;

/** Apply the way `db/migrations.ts` applies: one `exec`, one transaction, FKs off. */
function apply(sql: string = MIGRATION_SQL, target: Database.Database = db()): void {
  target.pragma('foreign_keys = OFF');
  target.transaction(() => target.exec(sql))();
  target.pragma('foreign_keys = ON');
}

/** Put a fully-migrated body back into the state a v3.3.0 box carries. */
const rewind = (): void => { db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_185); };

/**
 * The file's executable statements, comments stripped — so a row count can be attributed to the
 * statement that produced it. Splitting the commented file on `;` would split inside the prose.
 */
function statements(sql: string = MIGRATION_SQL): string[] {
  return sql.split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Fictional ids and prompts throughout (G1 — nothing here names a real agent or a real person).
const MODEL = 'model-185';
const PROVIDER = 'prov-185';

function seedRefs(target: Database.Database = db()): void {
  target.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  target.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["audio_generation","video_generation"]', 1, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  for (const id of ['agent-185-a', 'agent-185-b']) {
    target.prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, `Agent ${id.slice(-1)}`);
  }
}

interface GenSeed { id: string; status: string; kind?: string; agent?: string; error?: string | null; asset?: string | null; cost?: number | null }
function gen(p: GenSeed, target: Database.Database = db()): void {
  target.prepare(
    `INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, status, error, asset_path, cost_usd, started_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'a teapot orbiting a lighthouse', ?, ?, ?, ?, '2026-01-02 03:04:05', '2026-01-02 03:04:05', NULL)`,
  ).run(p.id, p.kind ?? 'image', p.agent ?? 'agent-185-a', MODEL, PROVIDER, p.status,
    p.error ?? null, p.asset ?? null, p.cost ?? null);
}

interface VidSeed { id: string; status: string; providerJobId: string | null; agent?: string; error?: string | null }
function vid(p: VidSeed, target: Database.Database = db()): void {
  target.prepare(
    `INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, error, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'a lighthouse at dusk', ?, ?, '2026-01-02 03:04:05', '2026-01-02 03:04:05')`,
  ).run(p.id, p.agent ?? 'agent-185-a', MODEL, PROVIDER, p.providerJobId, p.status, p.error ?? null);
}

const row = (table: 'generation_jobs' | 'video_jobs', id: string, target: Database.Database = db()) =>
  target.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;

const statusOf = (table: 'generation_jobs' | 'video_jobs', id: string) =>
  (row(table, id) as { status: string }).status;

const n = (sql: string): number => (db().prepare(sql).get() as { n: number }).n;

/**
 * THE LIVED-IN BODY. Two agents, both idle, carrying the wreckage of months plus the history
 * that has to survive it: finished work, a real failure with its own reason, a job the owner
 * cancelled, and a video render the provider is still working on.
 */
function fillLivedIn(): void {
  seedRefs();
  // ── abandoned: nothing can own these ──
  gen({ id: 'g-queued', status: 'queued' });
  gen({ id: 'g-running', status: 'running', kind: 'audio' });
  gen({ id: 'g-odd', status: 'uploading', kind: 'music', agent: 'agent-185-b' });   // unknown word
  gen({ id: 'g-shout', status: 'QUEUED', agent: 'agent-185-b' });                   // case trap
  gen({ id: 'g-blank', status: '' });                                               // empty word
  vid({ id: 'v-none', status: 'queued', providerJobId: null });
  vid({ id: 'v-empty', status: 'queued', providerJobId: '' });
  vid({ id: 'v-space', status: 'polling', providerJobId: '   ', agent: 'agent-185-b' });
  vid({ id: 'v-odd', status: 'uploading', providerJobId: null });                   // unknown word
  // ── history + genuinely live: must survive untouched ──
  gen({ id: 'g-ok', status: 'succeeded', asset: '/fixture/ok.png', cost: 0.04 });
  gen({ id: 'g-failed', status: 'failed', kind: 'audio', error: 'the provider refused the voice' });
  gen({ id: 'g-cut', status: 'cancelled' });
  vid({ id: 'v-live', status: 'polling', providerJobId: 'provider-job-live' });
  vid({ id: 'v-live-queued', status: 'queued', providerJobId: 'provider-job-queued' });
  vid({ id: 'v-live-odd', status: 'uploading', providerJobId: 'provider-job-odd' });
  vid({ id: 'v-ok', status: 'succeeded', providerJobId: 'provider-job-done' });
  vid({ id: 'v-cut', status: 'cancelled', providerJobId: null });                   // terminal wins
}

const ABANDONED = ['g-blank', 'g-odd', 'g-queued', 'g-running', 'g-shout',
  'v-empty', 'v-none', 'v-odd', 'v-space'];
const SURVIVORS = ['g-cut', 'g-failed', 'g-ok',
  'v-cut', 'v-live', 'v-live-odd', 'v-live-queued', 'v-ok'];

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().pragma('foreign_keys = ON');
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── BODY A ──────────────────────────────────────────────────────────────────────────────

describe('BODY A — a fresh install', () => {
  it('applies against empty tables, changes nothing, and is recorded', () => {
    expect(n('SELECT COUNT(*) AS n FROM generation_jobs')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM video_jobs')).toBe(0);
    expect(db().prepare('SELECT 1 FROM _migrations WHERE name = ?').get(MIGRATION_185)).toBeDefined();
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('sorts into the chain where it belongs', () => {
    const names = (db().prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{ name: string }>)
      .map((r) => r.name);
    const i = names.indexOf(MIGRATION_185);
    expect(i).toBeGreaterThan(names.indexOf('184_retire_two_writerless_exit_reasons.sql'));
    // Both job tables exist long before it, so neither UPDATE can meet a missing table.
    expect(i).toBeGreaterThan(names.indexOf('062_video_jobs.sql'));
    expect(i).toBeGreaterThan(names.indexOf('063_generation_jobs.sql'));
  });
});

// ── BODY B + C ──────────────────────────────────────────────────────────────────────────

describe('BODY B/C — a lived-in, adversarial body', () => {
  it('closes exactly the abandoned rows, with the reason, and deletes nothing', () => {
    fillLivedIn();
    rewind();
    const before = n('SELECT COUNT(*) AS n FROM generation_jobs') + n('SELECT COUNT(*) AS n FROM video_jobs');

    apply();

    for (const id of ABANDONED) {
      const table = id.startsWith('g-') ? 'generation_jobs' : 'video_jobs';
      const r = row(table, id);
      expect(r.status, `${id} was not closed`).toBe('failed');
      expect(r.error, `${id} carries the wrong reason`).toBe(REASON);
      expect(r.finished_at, `${id} has no finish time`).not.toBeNull();
    }
    // NOTHING IS DELETED — the record is the point.
    expect(n('SELECT COUNT(*) AS n FROM generation_jobs') + n('SELECT COUNT(*) AS n FROM video_jobs'))
      .toBe(before);
  });

  it('leaves every survivor byte-for-byte, including a live render and a real failure', () => {
    fillLivedIn();
    rewind();
    const snapshot = Object.fromEntries(SURVIVORS.map((id) =>
      [id, row(id.startsWith('g-') ? 'generation_jobs' : 'video_jobs', id)]));

    apply();

    for (const id of SURVIVORS) {
      const table = id.startsWith('g-') ? 'generation_jobs' : 'video_jobs';
      expect(row(table, id), `${id} was rewritten`).toEqual(snapshot[id]);
    }
    // Named, because these three are the ones a wrong predicate costs money and history:
    expect(statusOf('video_jobs', 'v-live')).toBe('polling');       // t114/U4 — the render lives
    expect(statusOf('video_jobs', 'v-live-odd')).toBe('uploading');
    expect(row('generation_jobs', 'g-failed').error).toBe('the provider refused the voice');
  });

  it('touches each branch: 5 generation rows, then 4 video rows', () => {
    fillLivedIn();
    rewind();
    const sts = statements();
    expect(sts, 'the file is no longer two statements').toHaveLength(2);

    db().pragma('foreign_keys = OFF');
    const first = db().prepare(sts[0]).run().changes;
    const second = db().prepare(sts[1]).run().changes;
    db().pragma('foreign_keys = ON');

    // A branch that touches zero rows is an untested branch.
    expect(first, 'the generation_jobs branch moved the wrong number of rows').toBe(5);
    expect(second, 'the video_jobs branch moved the wrong number of rows').toBe(4);
  });

  it('leaves a body with no abandoned rows completely alone (negative control)', () => {
    seedRefs();
    gen({ id: 'g-ok', status: 'succeeded', asset: '/fixture/ok.png', cost: 0.04 });
    vid({ id: 'v-live', status: 'polling', providerJobId: 'provider-job-live' });
    rewind();
    const before = db().prepare('SELECT * FROM generation_jobs').all();
    const beforeV = db().prepare('SELECT * FROM video_jobs').all();

    apply();

    expect(db().prepare('SELECT * FROM generation_jobs').all()).toEqual(before);
    expect(db().prepare('SELECT * FROM video_jobs').all()).toEqual(beforeV);
  });
});

// ── BODY D ──────────────────────────────────────────────────────────────────────────────

describe('BODY D — re-run', () => {
  it('is idempotent by its predicate, not by the _migrations marker', () => {
    fillLivedIn();
    rewind();
    apply();
    const after = {
      g: db().prepare('SELECT * FROM generation_jobs ORDER BY id').all(),
      v: db().prepare('SELECT * FROM video_jobs ORDER BY id').all(),
    };

    const sts = statements();
    db().pragma('foreign_keys = OFF');
    expect(db().prepare(sts[0]).run().changes, 'a second pass moved generation rows').toBe(0);
    expect(db().prepare(sts[1]).run().changes, 'a second pass moved video rows').toBe(0);
    db().pragma('foreign_keys = ON');

    expect(db().prepare('SELECT * FROM generation_jobs ORDER BY id').all()).toEqual(after.g);
    expect(db().prepare('SELECT * FROM video_jobs ORDER BY id').all()).toEqual(after.v);
  });
});

// ── BODY E ──────────────────────────────────────────────────────────────────────────────

describe('BODY E — a VACUUM INTO copy of a file body (G13)', () => {
  it('repairs the copy and leaves the original alone', () => {
    const origPath = path.join(TMP_ROOT, `body-${process.pid}.db`);
    const copyPath = path.join(TMP_ROOT, `body-${process.pid}-copy.db`);
    for (const p of [origPath, copyPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

    // A real file body, migrated by the real chain, carrying the lived-in shape.
    const orig = new Database(origPath);
    mockDb.current!.close();
    mockDb.current = orig;
    runMigrations();
    fillLivedIn();
    rewind();
    orig.prepare('VACUUM INTO ?').run(copyPath);
    orig.close();

    const copy = new Database(copyPath);
    apply(MIGRATION_SQL, copy);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE error = ?").get(REASON) as { n: number }).n).toBe(5);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM video_jobs WHERE error = ?").get(REASON) as { n: number }).n).toBe(4);
    expect((copy.prepare("SELECT status FROM video_jobs WHERE id = 'v-live'").get() as { status: string }).status)
      .toBe('polling');
    copy.close();

    // The rehearsal copy is where the repair happened; the body it came from is untouched.
    const reopened = new Database(origPath, { readonly: true });
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE error = ?").get(REASON) as { n: number }).n).toBe(0);
    reopened.close();

    mockDb.current = new Database(':memory:');
    for (const p of [origPath, copyPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
  });
});

// ── COUNTERFACTUAL ──────────────────────────────────────────────────────────────────────

describe('COUNTERFACTUAL — both halves of the video predicate are load-bearing', () => {
  it('without the provider-job-id clause, a live render is killed', () => {
    fillLivedIn();
    rewind();
    const mutated = MIGRATION_SQL.replace(
      "   AND (provider_job_id IS NULL OR trim(provider_job_id) = '');",
      ';',
    );
    expect(mutated, 'the mutation did not apply').not.toBe(MIGRATION_SQL);

    apply(mutated);

    // THE DEFECT THIS SHAPE AVOIDS (t114/U4): `failed` is terminal, the boot resume skips it,
    // the asset is never fetched, and the owner is billed for a video they never see.
    expect(statusOf('video_jobs', 'v-live')).toBe('failed');
  });

  it('without the terminal clause, a finished job loses its own verdict', () => {
    fillLivedIn();
    rewind();
    const mutated = MIGRATION_SQL
      .replace(" WHERE status NOT IN ('succeeded', 'failed', 'cancelled');", ';')
      .replace(" WHERE status NOT IN ('succeeded', 'failed', 'cancelled')\n", ' WHERE 1 = 1\n');
    expect(mutated).not.toBe(MIGRATION_SQL);

    apply(mutated);

    expect(statusOf('generation_jobs', 'g-ok'), 'the terminal clause is decorative').toBe('failed');
    expect(row('generation_jobs', 'g-failed').error).toBe(REASON);   // its real reason, erased
  });
});
