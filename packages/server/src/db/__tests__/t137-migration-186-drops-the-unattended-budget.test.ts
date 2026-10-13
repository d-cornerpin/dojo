// ════════════════════════════════════════════════════════════════════════════════════════
// t137 (v3.3.3) — MIGRATION 186 DROPS `providers.max_unattended_minutes`, AND NOTHING ELSE MOVES.
//
// OR-LONG-JOBS: no total-time cap. The column's reader, resolver, write doors, dashboard field
// and PM hand-off are deleted in the same change; this file pins what the migration does to the
// bodies that carry it, through the REAL runner (`runMigrations`), on four shapes:
//
//   BODY A  a fresh chain — the column never survives to the head;
//   BODY B  a v3.3.2-shaped body (column present, 186 pending) with an ADVERSARIAL fill — every
//           value a person, a hand edit or a restored backup could have left (NULL, the "no cap"
//           zero, floor, ceiling, negative, fractional, text, out-of-range) beside rows that
//           declared nothing — and every OTHER column on every row compared before and after;
//   BODY C  a body that lost the column by hand with 186 still pending — the REQUIRES-COLUMN
//           directive records the file as run instead of bricking the boot;
//   BODY D  a second boot — nothing changes.
//
// The full per-release rehearsal (every distinct published migration set, built from its own
// tag and upgraded on a VACUUM INTO copy) is in the t137 report; this file is the standing guard.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t137-migration-186');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t137-migration-186', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_186 = '186_drop_provider_unattended_budget.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', MIGRATION_186), 'utf-8');

const db = (): Database.Database => mockDb.current!;
const providerColumns = (): string[] =>
  (db().prepare('PRAGMA table_info(providers)').all() as Array<{ name: string }>).map((r) => r.name);
const recorded = (): number =>
  (db().prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').get(MIGRATION_186) as { n: number }).n;

/** A fully-migrated body put back into the shape every box on v3.1.26 – v3.3.2 carries. */
function rewindToBeforeDrop(): void {
  db().exec('ALTER TABLE providers ADD COLUMN max_unattended_minutes INTEGER;');
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_186);
}

/** Every value the column could be holding, beside rows that declared nothing. */
const ADVERSARIAL: Array<[string, unknown]> = [
  ['p-null', null], ['p-zero', 0], ['p-floor', 15], ['p-ceiling', 1440], ['p-two-hours', 120],
  ['p-negative', -5], ['p-fraction', 3.5], ['p-text', 'sixty'], ['p-huge', 99999], ['p-null-2', null],
];

function fillAdversarial(): void {
  const ins = db().prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type, first_chunk_timeout_ms,
                            prefill_tokens_per_sec, behaves_like, max_unattended_minutes,
                            is_validated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-07-01 09:00:00', '2026-09-01 09:00:00')`,
  );
  ADVERSARIAL.forEach(([id, budget], i) => ins.run(
    id, i >= 8 ? 'Same Name Twice' : `Provider ${i}`, i % 2 ? 'openai-compatible' : 'anthropic',
    i % 3 === 0 ? null : `https://${id}.example.test/v1`, i % 3 ? 'api_key' : 'none',
    i === 1 ? 600_000 : null, i === 2 ? 200 : null, i === 4 ? 'deepseek' : null, budget,
  ));
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled)
     VALUES (?, ?, ?, ?, '["tools"]', 1)`,
  );
  ADVERSARIAL.forEach(([id]) => model.run(`m-${id}`, id, `Model on ${id}`, `api-${id}`));
}

/** Every column EXCEPT the dropped one, on every row, plus the rows hanging off them. */
function snapshot(): Record<string, unknown> {
  const kept = providerColumns().filter((c) => c !== 'max_unattended_minutes');
  return {
    providers: db().prepare(`SELECT ${kept.map((c) => `"${c}"`).join(', ')} FROM providers ORDER BY id`).all(),
    models: db().prepare('SELECT * FROM models ORDER BY id').all(),
  };
}

beforeEach(() => {
  const d = new Database(':memory:');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the file itself', () => {
  it('drops exactly one column and declares the column it needs', () => {
    const code = MIGRATION_SQL.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE providers DROP COLUMN max_unattended_minutes']);
    expect(MIGRATION_SQL).toMatch(/^-- REQUIRES-COLUMN: providers\.max_unattended_minutes$/m);
  });
});

describe('BODY A — a fresh chain', () => {
  it('the head schema has no unattended-budget column, and 186 is recorded', () => {
    expect(providerColumns()).not.toContain('max_unattended_minutes');
    expect(recorded()).toBe(1);
  });
});

describe('BODY B — a v3.3.2-shaped body with an adversarial fill', () => {
  it('the column goes; every other column of every row, and every model, is byte-identical', () => {
    rewindToBeforeDrop();
    fillAdversarial();
    // Positive control: the body really carries the values the drop is about to remove — eight
    // non-NULL declarations of five SQLite types. A drop over an empty column proves nothing.
    const held = db().prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT typeof(max_unattended_minutes)) AS types
         FROM providers WHERE max_unattended_minutes IS NOT NULL`,
    ).get() as { n: number; types: number };
    expect(held).toEqual({ n: 8, types: 3 });
    const before = snapshot();
    const providerCount = (db().prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n;

    runMigrations();

    expect(providerColumns()).not.toContain('max_unattended_minutes');
    expect(recorded()).toBe(1);
    expect(snapshot()).toEqual(before);
    expect((db().prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n).toBe(providerCount);
    expect(db().prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('BODY C — the column already gone, 186 still pending', () => {
  it('the boot does not brick: the file is recorded as run without executing', () => {
    db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_186);
    expect(providerColumns()).not.toContain('max_unattended_minutes');
    expect(() => runMigrations()).not.toThrow();
    expect(recorded()).toBe(1);
  });
});

describe('BODY D — the re-run', () => {
  it('a second boot over an upgraded body changes nothing', () => {
    rewindToBeforeDrop();
    fillAdversarial();
    runMigrations();
    const once = snapshot();
    runMigrations();
    expect(snapshot()).toEqual(once);
    expect(recorded()).toBe(1);
  });
});
