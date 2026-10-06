// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 181 (cost_records.call_purpose + providers.measured_chars_per_token_prose[_at])
// — THE REHEARSAL ON AN ADVERSARIAL, LIVED-IN BODY.
//
// The update-integrity standard is binding: an update never fails. This file is migration
// 167's rehearsal shape, with one deliberate difference — the body is not merely lived-in, it
// is ADVERSARIAL (campaign G13): alongside correct rows it carries planted NULLs in every
// column the migration's readers consult, duplicate-shaped ledger rows, and rows orphaned from
// the provider they name. A purely additive migration must cross all of that untouched, and
// the point of planting it is that "additive" is a CLAIM until a body with teeth has crossed it.
//
// BODY A  a fresh install        — all three columns arrive and arrive NULL
// BODY B  AN ADVERSARIAL BODY    — applies without raising; every pre-existing row byte-identical
// BODY C  RE-RUN                 — the chain is idempotent; a second boot changes nothing
// BODY D  THE TYPES             — call_purpose takes TEXT, the prose reading takes a REAL
// BODY E  WHAT NULL MEANS        — no backfill happened, deliberately and checkably
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-migration-181');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-migration-181', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_181 = '181_call_purpose_and_prose_divisor.sql';
const COST_COLUMN = 'call_purpose';
const PROVIDER_COLUMNS = ['measured_chars_per_token_prose', 'measured_chars_per_token_prose_at'];

const db = (): Database.Database => mockDb.current!;

const columnsOf = (table: string): string[] =>
  (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);

/** Put a fully-migrated body back into the state a pre-181 box carries. */
const rewindTo180 = (): void => {
  db().exec(`ALTER TABLE cost_records DROP COLUMN ${COST_COLUMN};`);
  for (const col of PROVIDER_COLUMNS) db().exec(`ALTER TABLE providers DROP COLUMN ${col};`);
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_181);
};

/**
 * AN ADVERSARIAL BODY — correct rows AND the planted faults, counted.
 *
 * Every planted shape is one a real body can hold and one a reader added in this change will
 * meet: a NULL where the arithmetic wants a number, a row that cannot be joined to a provider,
 * and two rows identical in every field the readings key on. `foreign_keys` is OFF for the
 * orphan plant and back ON afterwards, because an orphan is precisely what the schema refuses
 * to let us insert and precisely what migration 173's sweeps prove bodies carry anyway.
 */
const PLANTED = { total: 0, nullEstimate: 0, nullDivisor: 0, orphan: 0, duplicate: 0, correct: 0 };

const fillAdversarial = (): void => {
  const d = db();
  for (const k of Object.keys(PLANTED) as Array<keyof typeof PLANTED>) PLANTED[k] = 0;

  d.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms,
                           stream_idle_timeout_ms, prefill_tokens_per_sec, max_unattended_minutes,
                           measured_chars_per_token, measured_chars_per_token_at,
                           behaves_like, is_validated, validated_at, created_at, updated_at)
    VALUES ('local', 'Local Floor', 'openai-compatible', 'http://10.0.0.4:8000/v1', 'none',
            600000, 120000, 200, 0, 2.07, '2026-09-20 11:00:00',
            'deepseek', 1, '2026-08-01 10:00:00', '2026-07-01 09:00:00', '2026-09-01 09:00:00')
  `).run();
  // A provider with NO prior reading at all — the state every box is in before 174 fires.
  d.prepare(`
    INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('cloudy', 'Cloudy', 'anthropic', 'api_key', 1, '2026-06-01 09:00:00', '2026-06-01 09:00:00')
  `).run();

  const model = d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, '["text","tools"]', 65536, 8192, 1, datetime('now'), datetime('now'))
  `);
  model.run('m-local', 'local', 'Local Floor', 'local-floor');
  model.run('m-cloudy', 'cloudy', 'Cloudy', 'cloudy-1');

  d.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES ('a-one', 'Agent One', 'm-local', 'idle', '{"tone":"dry"}', '2026-07-02 09:00:00', '2026-09-01 09:00:00')
  `).run();

  const cost = d.prepare(`
    INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                              cost_usd, latency_ms, request_type, cache_read_tokens,
                              estimated_input_tokens, estimator_chars_per_token, created_at)
    VALUES (?, 'a-one', 'm-local', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);

  // CORRECT ROWS — both populations, written the way the engine writes them today (no purpose
  // axis exists yet on a pre-181 body, which is exactly why the column must arrive NULL).
  for (let i = 0; i < 20; i++) {
    cost.run(`ok-turn-${i}`, 'local', 20_000 + i * 11, 300 + i, 0.004, 41_000, 'agent_turn', 9_000, 12_000 + i, 4, `-${i} days`);
    PLANTED.correct++; PLANTED.total++;
  }
  for (let i = 0; i < 8; i++) {
    cost.run(`ok-dial-${i}`, 'local', 900 + i, 40 + i, 0.0002, 2_100, 'completion', null, 2_400 + i, 4, `-${i} days`);
    PLANTED.correct++; PLANTED.total++;
  }

  // FAULT 1 — a NULL estimate. The reading's own window predicate excludes these; a body is
  // mostly made of them (every ollama / agent-sdk row).
  for (let i = 0; i < 6; i++) {
    cost.run(`null-est-${i}`, 'local', 5_000, 100, 0.001, 20_000, 'completion', null, null, null, `-${i} days`);
    PLANTED.nullEstimate++; PLANTED.total++;
  }

  // FAULT 2 — an estimate with a NULL divisor beside it. The pair is supposed to travel
  // together; a row where it did not is the shape guard 2 exists for.
  for (let i = 0; i < 4; i++) {
    cost.run(`null-div-${i}`, 'local', 7_000, 120, 0.002, 25_000, 'agent_turn', null, 30_000, null, `-${i} days`);
    PLANTED.nullDivisor++; PLANTED.total++;
  }

  // FAULT 3 — rows naming a provider that is not there. Migration 173 proved bodies hold these.
  d.pragma('foreign_keys = OFF');
  for (let i = 0; i < 3; i++) {
    cost.run(`orphan-${i}`, 'ghost-provider', 8_000, 150, 0.003, 26_000, 'agent_turn', null, 33_000, 4, `-${i} days`);
    PLANTED.orphan++; PLANTED.total++;
  }
  d.pragma('foreign_keys = ON');

  // FAULT 4 — duplicates: identical in every field the two readings key on, differing only by
  // primary key. A fold that is a MINIMUM must be indifferent to multiplicity, and a body that
  // never contained a pair could not show that it is.
  for (let i = 0; i < 2; i++) {
    cost.run(`dupe-${i}`, 'local', 6_000, 110, 0.0015, 22_000, 'agent_turn', 4_000, 28_000, 4, '-1 days');
    PLANTED.duplicate++; PLANTED.total++;
  }
};

/** Everything that must be identical on the far side, as one comparable snapshot. */
const snapshot = (): Record<string, unknown> => ({
  providers: db().prepare(`
    SELECT id, name, type, base_url, auth_type, behaves_like, first_chunk_timeout_ms,
           stream_idle_timeout_ms, prefill_tokens_per_sec, max_unattended_minutes,
           measured_chars_per_token, measured_chars_per_token_at,
           is_validated, validated_at, created_at, updated_at
      FROM providers ORDER BY id
  `).all(),
  models: db().prepare('SELECT * FROM models ORDER BY id').all(),
  agents: db().prepare('SELECT * FROM agents ORDER BY id').all(),
  costRecords: db().prepare(`
    SELECT id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd,
           latency_ms, request_type, cache_read_tokens, cache_creation_tokens,
           estimated_input_tokens, estimator_chars_per_token
      FROM cost_records ORDER BY id
  `).all(),
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
  it('all three columns arrive', () => {
    expect(columnsOf('cost_records')).toContain(COST_COLUMN);
    for (const col of PROVIDER_COLUMNS) expect(columnsOf('providers')).toContain(col);
  });

  it('a new ledger row defaults to NULL — "this row did not say", never a guessed purpose', () => {
    db().prepare(`
      INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
      VALUES ('p', 'P', 'openai', 'api_key', 0, datetime('now'), datetime('now'))
    `).run();
    db().prepare(`
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
      VALUES ('m', 'p', 'M', 'm', '["text"]', 8192, 1024, 1, datetime('now'), datetime('now'))
    `).run();
    db().prepare(`
      INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
      VALUES ('ag', 'Ag', 'm', 'idle', datetime('now'), datetime('now'))
    `).run();
    db().prepare(`
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
      VALUES ('c', 'ag', 'm', 'p', 10, 10, 0.0, datetime('now'))
    `).run();
    expect(db().prepare(`SELECT ${COST_COLUMN} AS p FROM cost_records WHERE id = 'c'`).get())
      .toEqual({ p: null });
    expect(db().prepare(
      'SELECT measured_chars_per_token_prose AS d, measured_chars_per_token_prose_at AS at FROM providers WHERE id = ?',
    ).get('p')).toEqual({ d: null, at: null });
  });

  it('recorded itself in `_migrations`, so a second boot does not re-run it', () => {
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_181))
      .toEqual({ n: 1 });
  });
});

describe('BODY B — AN ADVERSARIAL BODY (the one that decides the entry)', () => {
  it('the planted body really does carry every fault it claims to', () => {
    rewindTo180();
    fillAdversarial();
    // Zero of any class would mean a branch below is untested (G13), so the counts are asserted
    // rather than assumed — and asserted against the DATABASE, not against the counter.
    expect(PLANTED.correct).toBe(28);
    expect(PLANTED.nullEstimate).toBe(6);
    expect(PLANTED.nullDivisor).toBe(4);
    expect(PLANTED.orphan).toBe(3);
    expect(PLANTED.duplicate).toBe(2);
    expect(db().prepare('SELECT COUNT(*) AS n FROM cost_records').get()).toEqual({ n: PLANTED.total });
    expect(db().prepare(
      'SELECT COUNT(*) AS n FROM cost_records WHERE estimated_input_tokens IS NULL',
    ).get()).toEqual({ n: PLANTED.nullEstimate });
    expect(db().prepare(
      'SELECT COUNT(*) AS n FROM cost_records WHERE estimated_input_tokens IS NOT NULL AND estimator_chars_per_token IS NULL',
    ).get()).toEqual({ n: PLANTED.nullDivisor });
    expect(db().prepare(`
      SELECT COUNT(*) AS n FROM cost_records c
       WHERE NOT EXISTS (SELECT 1 FROM providers p WHERE p.id = c.provider_id)
    `).get()).toEqual({ n: PLANTED.orphan });
  });

  it('⚠ APPLIES WITHOUT RAISING — a migration that refuses a lived-in body refuses the BOOT', () => {
    rewindTo180();
    fillAdversarial();
    expect(() => runMigrations()).not.toThrow();
  });

  it('every pre-existing row survives BYTE-FOR-BYTE across the three columns arriving', () => {
    rewindTo180();
    fillAdversarial();
    const before = snapshot();
    runMigrations();
    expect(snapshot()).toEqual(before);
  });

  it('the columns arrive NULL on every row that was already there — no backfill, by design', () => {
    rewindTo180();
    fillAdversarial();
    expect(columnsOf('cost_records')).not.toContain(COST_COLUMN);
    runMigrations();
    expect(columnsOf('cost_records')).toContain(COST_COLUMN);
    expect(db().prepare(
      `SELECT COUNT(*) AS n FROM cost_records WHERE ${COST_COLUMN} IS NOT NULL`,
    ).get()).toEqual({ n: 0 });
    const provs = db().prepare(
      'SELECT id, measured_chars_per_token_prose AS d, measured_chars_per_token_prose_at AS at FROM providers ORDER BY id',
    ).all() as Array<{ id: string; d: number | null; at: string | null }>;
    // The two seeded above plus the `__system__` row the chain itself creates.
    expect(provs.length).toBeGreaterThanOrEqual(3);
    for (const p of provs) expect({ d: p.d, at: p.at }).toEqual({ d: null, at: null });
  });

  it('the EXISTING 174 reading is untouched — this migration redefines nothing', () => {
    rewindTo180();
    fillAdversarial();
    runMigrations();
    expect(db().prepare(
      'SELECT measured_chars_per_token AS d, measured_chars_per_token_at AS at FROM providers WHERE id = ?',
    ).get('local')).toEqual({ d: 2.07, at: '2026-09-20 11:00:00' });
  });
});

describe('BODY C — RE-RUN', () => {
  it('a second boot is a no-op: the chain does not re-apply and nothing moves', () => {
    rewindTo180();
    fillAdversarial();
    runMigrations();
    const after = snapshot();
    expect(() => runMigrations()).not.toThrow();
    expect(snapshot()).toEqual(after);
    expect(db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_181))
      .toEqual({ n: 1 });
  });
});

describe('BODY D — THE TYPES', () => {
  it('the prose divisor takes a REAL, because a measurement is a quotient and not a round number', () => {
    // INTEGER here would truncate 4.083 to 4 at the WRITE and the whole reading would collapse
    // back onto the constant it exists to replace — silently, and indistinguishably.
    db().prepare(`
      INSERT INTO providers (id, name, type, auth_type, measured_chars_per_token_prose,
                             measured_chars_per_token_prose_at, is_validated, created_at, updated_at)
      VALUES ('p', 'P', 'openai', 'api_key', 4.083, '2026-10-05 09:00:00', 0, datetime('now'), datetime('now'))
    `).run();
    const row = db().prepare(
      'SELECT measured_chars_per_token_prose AS d FROM providers WHERE id = ?',
    ).get('p') as { d: number };
    expect(row.d).toBeCloseTo(4.083, 3);
  });

  it('call_purpose takes the purpose words the engine declares, unabridged', () => {
    db().prepare(`
      INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
      VALUES ('p', 'P', 'openai', 'api_key', 0, datetime('now'), datetime('now'))
    `).run();
    db().prepare(`
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
      VALUES ('m', 'p', 'M', 'm', '["text"]', 8192, 1024, 1, datetime('now'), datetime('now'))
    `).run();
    db().prepare(`
      INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
      VALUES ('ag', 'Ag', 'm', 'idle', datetime('now'), datetime('now'))
    `).run();
    const ins = db().prepare(`
      INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens,
                                cost_usd, request_type, call_purpose, created_at)
      VALUES (?, 'ag', 'm', 'p', 10, 10, 0.0, ?, ?, datetime('now'))
    `);
    // THE ROW SHAPE THE WHOLE DESIGN TURNS ON: the router decided `light`, and the call was
    // still a TURN. Before this column the second fact was unrecoverable.
    ins.run('tiered-turn', 'light', 'agent_turn');
    ins.run('plain-turn', 'agent_turn', 'agent_turn');
    ins.run('dial', 'ask_title', 'ask_title');
    ins.run('undeclared', 'completion', null);
    expect(db().prepare(`
      SELECT COUNT(*) AS n FROM cost_records WHERE call_purpose = 'agent_turn'
    `).get()).toEqual({ n: 2 });
    expect(db().prepare(`
      SELECT request_type AS rt FROM cost_records WHERE id = 'tiered-turn'
    `).get()).toEqual({ rt: 'light' });
  });
});
