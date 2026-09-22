// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 167 (providers.measured_prefill_*) — THE REHEARSAL ON A LIVED-IN BODY.
//
// The update-integrity standard is binding: an update never fails, and a migration that
// refuses — or quietly damages — a body that has been in use for months is the `.23` / `135`
// incident class. Roadmap #16: every plan-supplied artefact is rehearsed against reality
// before it is trusted, and for a migration that means BODIES.
//
// ── HOW THE PRE-167 BODY IS BUILT, AND WHY THAT IS HONEST ──
// The chain is directory-scanned, so there is no "run everything up to 166" switch. This file
// builds the real thing instead: run the FULL chain on a fresh database, then put it back into
// its pre-167 state — drop the two columns and the index 167 adds, and remove 167's own row
// from `_migrations`. What remains is byte-for-byte what a box that last updated at v3.1.26
// carries. It is then FILLED with the kind of rows such a box actually holds — providers that
// declared their patience, providers that declared nothing, models, agents, months of messages
// and a cost ledger — and only then is the chain run again.
//
// BODY A  a fresh install        — the DDL runs on an empty body and the columns arrive NULL
// BODY B  a LIVED-IN stable body — every pre-existing row survives byte-for-byte
// BODY C  RE-RUN                 — the chain is idempotent; a second boot changes nothing
// BODY D  THE INDEX              — 167's partial index exists and is the one the rescan needs
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-167');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-167', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_167 = '167_provider_measured_prefill.sql';
const NEW_COLUMNS = ['measured_prefill_tokens_per_sec', 'measured_prefill_at'];
const NEW_INDEX = 'idx_cost_records_prefill_sample';

const db = (): Database.Database => mockDb.current!;

const providerColumns = (): string[] =>
  (db().prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>).map(r => r.name);

/** Put a fully-migrated body back into the state a v3.1.26 box carries. */
const rewindTo166 = (): void => {
  for (const col of NEW_COLUMNS) db().exec(`ALTER TABLE providers DROP COLUMN ${col};`);
  db().exec(`DROP INDEX IF EXISTS ${NEW_INDEX};`);
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_167);
};

/** The rows a box that has been in use actually holds. */
const fillLivedIn = (): void => {
  const d = db();
  // A provider that declared its patience and its throughput (the owner's local box), one that
  // declared a budget only, and a cloud provider that declared nothing at all.
  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms,
                           stream_idle_timeout_ms, prefill_tokens_per_sec, max_unattended_minutes,
                           behaves_like, is_validated, validated_at, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', 'http://192.168.1.9:8000/v1', 'none',
            600000, 120000, 200, 0, 'deepseek', 1, '2026-08-01 10:00:00', '2026-07-01 09:00:00', '2026-09-01 09:00:00')
  `).run();
  d.prepare(`
    INSERT INTO providers (id, name, type, auth_type, max_unattended_minutes, is_validated, created_at, updated_at)
    VALUES ('anthropic', 'Anthropic', 'anthropic', 'api_key', 120, 1, '2026-06-01 09:00:00', '2026-06-01 09:00:00')
  `).run();
  d.prepare(`
    INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('openai', 'OpenAI', 'openai', 'api_key', 1, '2026-06-02 09:00:00', '2026-06-02 09:00:00')
  `).run();

  const model = d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, '["text","tools"]', 65536, 8192, 1, datetime('now'), datetime('now'))
  `);
  model.run('m-local', 'local', 'Local DS4', 'local-ds4');
  model.run('m-anthropic', 'anthropic', 'Claude', 'claude-x');

  d.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('kevin', 'Kevin', 'm-local', 'idle', '{"tone":"dry"}', '2026-07-02 09:00:00', '2026-09-01 09:00:00')
  `).run();

  // `messages.created_at` is epoch-ms INTEGER and CHECK-constrained to be one (migration 131),
  // unlike every `*_at` on `providers` — the mixture the ISO-timestamp instrument exists to
  // name. A lived-in body is only lived-in if it is written the way the engine writes it.
  const msg = d.prepare(`
    INSERT INTO messages (id, agent_id, role, content, token_count, model_id, created_at)
    VALUES (?, 'kevin', ?, ?, ?, 'm-local', ?)
  `);
  const DAY_MS = 86_400_000;
  for (let i = 0; i < 40; i++) {
    msg.run(`msg-${i}`, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`, 12 + i, Date.now() - i * DAY_MS);
  }

  const cost = d.prepare(`
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                              cost_usd, latency_ms, cache_read_tokens, created_at)
    VALUES (?, 'kevin', 'm-local', 'local', ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  for (let i = 0; i < 60; i++) {
    cost.run(`cost-${i}`, 3_000 + i * 700, 200 + i, 0.0, 40_000 + i * 1_000, i % 3 === 0 ? 20_000 : null, `-${i} days`);
  }
};

/** Everything that must be identical on the far side, as one comparable snapshot. */
const snapshot = (): Record<string, unknown> => ({
  providers: db().prepare(`
    SELECT id, name, type, base_url, auth_type, behaves_like, first_chunk_timeout_ms,
           stream_idle_timeout_ms, prefill_tokens_per_sec, max_unattended_minutes,
           is_validated, validated_at, created_at, updated_at
      FROM providers ORDER BY id
  `).all(),
  models: db().prepare('SELECT * FROM models ORDER BY id').all(),
  agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
  messages: db().prepare('SELECT id, agent_id, role, content, token_count FROM messages ORDER BY id').all(),
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
  it('the chain leaves both columns present and NULL, which is "nothing measured yet"', () => {
    for (const col of NEW_COLUMNS) expect(providerColumns()).toContain(col);
    db().prepare(`
      INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
      VALUES ('p', 'P', 'openai', 'api_key', 0, datetime('now'), datetime('now'))
    `).run();
    expect(db().prepare(
      'SELECT measured_prefill_tokens_per_sec AS rate, measured_prefill_at AS at FROM providers WHERE id = ?',
    ).get('p')).toEqual({ rate: null, at: null });
  });

  it('the column takes a REAL, because a measurement is a quotient and not a round number', () => {
    // INTEGER here would silently truncate 181.07 at the WRITE, and the reader's own floor
    // would then be the second truncation of a number that had already lost its fraction.
    db().prepare(`
      INSERT INTO providers (id, name, type, auth_type, measured_prefill_tokens_per_sec, is_validated, created_at, updated_at)
      VALUES ('p', 'P', 'openai', 'api_key', 181.07, 0, datetime('now'), datetime('now'))
    `).run();
    const row = db().prepare('SELECT measured_prefill_tokens_per_sec AS rate FROM providers WHERE id = ?').get('p') as { rate: number };
    expect(row.rate).toBeCloseTo(181.07, 2);
  });

  it('recorded itself in `_migrations`, so a second boot does not re-run it', () => {
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_167))
      .toEqual({ n: 1 });
  });
});

describe('BODY B — A LIVED-IN STABLE BODY (the one that decides the entry)', () => {
  it('⚠ APPLIES WITHOUT RAISING — a migration that refuses a lived-in body refuses the BOOT', () => {
    rewindTo166();
    fillLivedIn();
    expect(() => runMigrations()).not.toThrow();
  });

  it('the two columns arrive, NULL on every row that was already there', () => {
    rewindTo166();
    fillLivedIn();
    expect(providerColumns()).not.toContain(NEW_COLUMNS[0]);
    runMigrations();
    for (const col of NEW_COLUMNS) expect(providerColumns()).toContain(col);
    const rows = db().prepare(
      'SELECT id, measured_prefill_tokens_per_sec AS rate, measured_prefill_at AS at FROM providers ORDER BY id',
    ).all() as Array<{ id: string; rate: number | null; at: string | null }>;
    // Three seeded above, plus the `__system__` row the chain itself creates — which is a
    // provider row like any other and must arrive NULL like any other.
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.rate, `${r.id} must not be handed a guessed number`).toBeNull();
      expect(r.at, `${r.id} must not be handed a guessed stamp`).toBeNull();
    }
  });

  it('NO DATA LOSS — every pre-existing row is byte-for-byte what it was', () => {
    rewindTo166();
    fillLivedIn();
    const before = snapshot();
    runMigrations();
    expect(snapshot()).toEqual(before);
  });

  it('and the declarations a person actually made are still theirs', () => {
    // The columns 163/164/166 added are the ones a reader would most plausibly disturb by
    // rewriting a table, and they are exactly the ones this feature's precedence rests on.
    rewindTo166();
    fillLivedIn();
    runMigrations();
    expect(db().prepare(`
      SELECT first_chunk_timeout_ms AS patience, prefill_tokens_per_sec AS speed,
             max_unattended_minutes AS budget, behaves_like AS dialect
        FROM providers WHERE id = 'local'
    `).get()).toEqual({ patience: 600_000, speed: 200, budget: 0, dialect: 'deepseek' });
  });
});

describe('BODY C — THE RE-RUN', () => {
  it('a second boot over the same body changes nothing at all', () => {
    rewindTo166();
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
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_167))
      .toEqual({ n: 1 });
  });
});

describe('BODY D — THE INDEX the window rescan needs', () => {
  it('exists, is partial, and is on the columns the rescan actually filters by', () => {
    const idx = db().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(NEW_INDEX) as { sql: string } | undefined;
    expect(idx, 'the rescan would be a full scan of the largest table without it').toBeDefined();
    expect(idx!.sql).toContain('cost_records');
    expect(idx!.sql).toContain('provider_id');
    expect(idx!.sql).toContain('created_at');
    expect(idx!.sql, 'partial: a row with no latency can never be a sample').toContain('latency_ms IS NOT NULL');
  });

  it('SQLite actually USES it for the rescan\'s shape', () => {
    rewindTo166();
    fillLivedIn();
    runMigrations();
    const plan = db().prepare(`
      EXPLAIN QUERY PLAN
      SELECT input_tokens, latency_ms FROM cost_records
       WHERE provider_id = ? AND latency_ms IS NOT NULL AND created_at >= datetime('now', ?)
    `).all('local', '-30 days') as Array<{ detail: string }>;
    expect(plan.map(r => r.detail).join(' ')).toContain(NEW_INDEX);
  });
});
