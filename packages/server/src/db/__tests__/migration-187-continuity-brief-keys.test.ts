// ════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION 187 (t140) — THE CONTINUITY BRIEF'S STORED KEYS, REHEARSED (G13).
//
// t140 deletes the continuity brief's writer and lane. This file's subject is the copies
// already stored on every upgraded box: three keys inside `agents.config` JSON. The migration
// is a JSON key removal, and the clauses that earn their keep are the SURVIVORS — the
// neighbouring keys of the same config, and the rows whose config is not something
// `json_remove` can safely read (it RAISES on malformed JSON, and a raise here fails the whole
// migration chain and the boot with it).
//
// BODY A  a fresh install        — applies against an empty table, changes nothing
// BODY B  a lived-in body        — the three keys go; every neighbour key is byte-identical
// BODY C  ADVERSARIAL            — NULL, empty, malformed, array and scalar configs; keys at
//                                  JSON null; the key nested one level down (must survive);
//                                  an agent with neighbours only (must not be rewritten)
// BODY D  RE-RUN                 — idempotent by its PREDICATE, not by the `_migrations` marker
// BODY E  A VACUUM INTO COPY     — the repair applied to a copy of a real file body, the way a
//                                  rehearsal copies one; the original is untouched
// PER-STATEMENT ROW COUNTS       — the one statement's touched-row count, per body
// COUNTERFACTUAL                 — the json_valid guard is load-bearing: without it the
//                                  adversarial body raises and the migration fails
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-migration-187');

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-migration-187', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../migrations.js';

const MIGRATION_187 = '187_drop_continuity_brief_keys.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(HERE, '..', 'migrations', MIGRATION_187), 'utf-8');

/** The one statement, comments stripped, so its touched-row count can be read. */
const STATEMENT = MIGRATION_SQL.replace(/^\s*--.*$/gm, '').trim();

const db = (): Database.Database => mockDb.current!;

/** Apply the way `db/migrations.ts` applies (one transaction, FKs off) and return the rows the
 *  statement touched. */
function apply(target: Database.Database = db(), sql: string = STATEMENT): number {
  target.pragma('foreign_keys = OFF');
  let changes = 0;
  target.transaction(() => { changes = target.prepare(sql).run().changes; })();
  target.pragma('foreign_keys = ON');
  return changes;
}

function seedAgent(target: Database.Database, id: string, config: string | null): void {
  target.prepare(
    `INSERT INTO agents (id, name, status, config, created_at, updated_at) VALUES (?, ?, 'idle', ?, datetime('now'), datetime('now'))`,
  ).run(id, `Fixture ${id}`, config);
}

function configOf(target: Database.Database, id: string): string | null {
  return (target.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string | null }).config;
}

const BRIEF = '[CONTINUITY BRIEF, Oct 1, 2026, 09:00 AM UTC, generated before memory compaction]\n## What the user has told the agent\nCount the crates.';

/** A lived-in config: the three keys among neighbours that must survive untouched. */
const LIVED_IN = JSON.stringify({
  scratchpad: 'north dock: 42 crates',
  continuityBrief: BRIEF,
  continuityBriefAt: '2026-10-01T09:00:00.000Z',
  continuityBriefValidUntilTurn: 1234,
  toolResultsStubbedBeforeTurn: 1200,
});

beforeEach(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  mockDb.current = new Database(':memory:');
  runMigrations();   // the whole chain, 187 included: the bodies below are applied to directly
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('migration 187 — the chain registers it', () => {
  it('is recorded in _migrations on a fresh install', () => {
    const row = db().prepare('SELECT name FROM _migrations WHERE name = ?').get(MIGRATION_187);
    expect(row).toBeTruthy();
  });
});

describe('BODY A — a fresh install', () => {
  it('touches zero rows on an empty table', () => {
    expect(apply()).toBe(0);
  });
});

describe('BODY B — a lived-in body', () => {
  it('removes exactly the three keys and leaves every neighbour byte-identical', () => {
    seedAgent(db(), 'a-lived', LIVED_IN);
    expect(apply()).toBe(1);
    const after = JSON.parse(configOf(db(), 'a-lived')!) as Record<string, unknown>;
    expect(after).toEqual({
      scratchpad: 'north dock: 42 crates',
      toolResultsStubbedBeforeTurn: 1200,
    });
  });
});

describe('BODY C — adversarial', () => {
  // (A NULL config is not reachable: `agents.config` is NOT NULL in the schema. The statement
  // still guards it, for a body imported from a version that allowed one.)
  const ADVERSARIAL: Array<[string, string | null, 'untouched' | 'stripped']> = [
    ['c-empty', '', 'untouched'],
    ['c-malformed', '{"continuityBrief": "half a brief', 'untouched'],
    ['c-array', '["continuityBrief", 1]', 'untouched'],
    ['c-scalar', '"continuityBrief"', 'untouched'],
    ['c-nested', '{"settings":{"continuityBrief":"stays"}}', 'untouched'],
    ['c-neighbours-only', '{"scratchpad":"keep me"}', 'untouched'],
    ['c-json-null', '{"continuityBrief":null,"scratchpad":"keep"}', 'stripped'],
    ['c-at-only', '{"continuityBriefAt":"2026-10-01T09:00:00Z"}', 'stripped'],
    ['c-turn-only', '{"continuityBriefValidUntilTurn":12,"other":true}', 'stripped'],
  ];

  it('strips exactly the rows carrying a key, and never raises on a config it cannot read', () => {
    for (const [id, cfg] of ADVERSARIAL) seedAgent(db(), id, cfg);
    seedAgent(db(), 'c-lived', LIVED_IN);
    const before = new Map(ADVERSARIAL.map(([id]) => [id, configOf(db(), id)]));

    const touched = apply();
    // Three adversarial "stripped" rows plus the lived-in one. Zero would mean an untested branch.
    expect(touched).toBe(4);

    for (const [id, , expectation] of ADVERSARIAL) {
      const now = configOf(db(), id);
      if (expectation === 'untouched') {
        expect(now, `${id} must be byte-identical`).toBe(before.get(id));
      } else {
        const parsed = JSON.parse(now!) as Record<string, unknown>;
        expect(Object.keys(parsed).some((k) => k.startsWith('continuityBrief')), `${id} still carries a key`).toBe(false);
      }
    }
    expect(JSON.parse(configOf(db(), 'c-json-null')!)).toEqual({ scratchpad: 'keep' });
    expect(JSON.parse(configOf(db(), 'c-at-only')!)).toEqual({});
    expect(JSON.parse(configOf(db(), 'c-turn-only')!)).toEqual({ other: true });
  });

  it('COUNTERFACTUAL: without the json_valid guard the malformed config raises and the migration fails', () => {
    seedAgent(db(), 'c-malformed', '{"continuityBrief": "half a brief');
    const unguarded = `UPDATE agents
       SET config = json_remove(config, '$.continuityBrief', '$.continuityBriefAt', '$.continuityBriefValidUntilTurn')
     WHERE json_type(config, '$.continuityBrief') IS NOT NULL
        OR json_type(config, '$.continuityBriefAt') IS NOT NULL
        OR json_type(config, '$.continuityBriefValidUntilTurn') IS NOT NULL`;
    expect(() => apply(db(), unguarded)).toThrow(/malformed JSON/i);
    // And the real statement on the same body is safe.
    expect(() => apply()).not.toThrow();
  });
});

describe('BODY D — re-run', () => {
  it('is idempotent by its predicate: a second run touches zero rows and changes no bytes', () => {
    seedAgent(db(), 'd-lived', LIVED_IN);
    expect(apply()).toBe(1);
    const once = configOf(db(), 'd-lived');
    expect(apply()).toBe(0);
    expect(configOf(db(), 'd-lived')).toBe(once);
  });
});

describe('BODY E — a VACUUM INTO copy of a file body', () => {
  it('repairs the copy and leaves the original file untouched', () => {
    const original = path.join(TMP_ROOT, `body-e-${process.pid}-${Date.now()}.db`);
    const copy = `${original}.copy`;
    // A real file body built by the real chain, then lived in.
    const memory = mockDb.current;
    const file = new Database(original);
    try {
      mockDb.current = file;
      runMigrations();
      seedAgent(file, 'e-lived', LIVED_IN);
      seedAgent(file, 'e-malformed', '{"continuityBriefAt": ');
      file.prepare('VACUUM INTO ?').run(copy);
    } finally {
      mockDb.current = memory;
      file.close();
    }
    const rehearsal = new Database(copy);
    try {
      expect(apply(rehearsal)).toBe(1);
      expect(Object.keys(JSON.parse(configOf(rehearsal, 'e-lived')!) as object).sort())
        .toEqual(['scratchpad', 'toolResultsStubbedBeforeTurn']);
      expect(configOf(rehearsal, 'e-malformed')).toBe('{"continuityBriefAt": ');
    } finally {
      rehearsal.close();
    }
    const untouched = new Database(original, { readonly: true });
    try {
      expect(configOf(untouched, 'e-lived')).toBe(LIVED_IN);
    } finally {
      untouched.close();
      fs.rmSync(original, { force: true });
      fs.rmSync(copy, { force: true });
    }
  });
});
