// PHASE-5 T10 Step 3 — MIGRATION 156, driven against real bodies.
//
// THE REQUIREMENT: the eight legacy `config` rows that duplicate the Workspace
// OAuth tokens are deleted, and a legacy row that is the ONLY copy of a token is
// never deleted — because migrations run BEFORE the boot seed that reads them,
// so an unguarded delete destroys the very connection the seed exists to migrate.
//
// A CLEAN BODY PROVES NOTHING (the `.23`/`144` incident is the reason this rule
// exists), so every body below is planted:
//   * the DUPLICATE body     — legacy keys AND account rows: the dev box's shape
//   * the SOLE-COPY body     — legacy keys, NO account rows: the not-yet-seeded box
//   * the MIXED body         — one kind seeded, one not, per provider
//   * the FRESH-INSTALL body — no legacy keys at all, nothing to do
//   * the COUNTERFACTUAL     — the guards stripped, on the sole-copy body: THROWS
//
// ⚠ No token value is printed. The planted values are invented literals and the
// assertions are on key PRESENCE and on counts.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const FILE = '156_legacy_oauth_token_rows.sql';
const SQL = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf-8');

const TOKEN_KEYS = [
  'gws_access_token', 'gws_refresh_token',
  'gws_user_access_token', 'gws_user_refresh_token',
  'ms_access_token', 'ms_refresh_token',
  'ms_user_access_token', 'ms_user_refresh_token',
] as const;

/** The keys migration 156 must never touch, whatever else it does. */
const NON_TOKEN_LEGACY_KEYS = [
  'gws_connected', 'gws_account_email', 'gws_enabled', 'gws_watch_email',
  'ms_connected', 'ms_account_email', 'ms_enabled',
] as const;

/** A database with just enough schema for this migration to be meaningful. */
function body(opts: {
  legacyTokens?: boolean;
  googleKinds?: Array<'agent' | 'user'>;
  msKinds?: Array<'agent' | 'user'>;
}): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE google_accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE microsoft_accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, position INTEGER NOT NULL);
  `);
  if (opts.legacyTokens !== false) {
    const ins = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
    for (const k of TOKEN_KEYS) ins.run(k, `planted-value-for-${k}`);
    for (const k of NON_TOKEN_LEGACY_KEYS) ins.run(k, 'true');
  }
  for (const kind of opts.googleKinds ?? []) {
    db.prepare('INSERT INTO google_accounts (id, kind, position) VALUES (?, ?, 1)').run(kind, kind);
  }
  for (const kind of opts.msKinds ?? []) {
    db.prepare('INSERT INTO microsoft_accounts (id, kind, position) VALUES (?, ?, 1)').run(kind, kind);
  }
  return db;
}

const surviving = (db: Database.Database): string[] =>
  (db.prepare(
    `SELECT key FROM config WHERE key IN (${TOKEN_KEYS.map(() => '?').join(',')}) ORDER BY key`,
  ).all(...TOKEN_KEYS) as Array<{ key: string }>).map(r => r.key);

/** Apply exactly as the runner does: one transaction around the whole file. */
function apply(db: Database.Database, sql = SQL): void {
  db.transaction(() => db.exec(sql))();
}

describe('PHASE-5 T10 migration 156: the DUPLICATE body (the dev box shape)', () => {
  it('deletes all eight token rows when every kind is already seeded', () => {
    const db = body({ googleKinds: ['agent', 'user'], msKinds: ['agent', 'user'] });
    expect(surviving(db)).toHaveLength(8);
    apply(db);
    expect(surviving(db)).toEqual([]);
    db.close();
  });

  it('leaves every NON-token legacy key alone — two live reader families depend on them', () => {
    const db = body({ googleKinds: ['agent', 'user'], msKinds: ['agent', 'user'] });
    apply(db);
    const kept = (db.prepare(
      `SELECT key FROM config WHERE key IN (${NON_TOKEN_LEGACY_KEYS.map(() => '?').join(',')}) ORDER BY key`,
    ).all(...NON_TOKEN_LEGACY_KEYS) as Array<{ key: string }>).map(r => r.key);
    expect(kept).toEqual([...NON_TOKEN_LEGACY_KEYS].sort());
    db.close();
  });

  it('is idempotent — applying it twice is not an error and changes nothing', () => {
    const db = body({ googleKinds: ['agent', 'user'], msKinds: ['agent', 'user'] });
    apply(db);
    expect(() => apply(db)).not.toThrow();
    expect(surviving(db)).toEqual([]);
    db.close();
  });
});

describe('PHASE-5 T10 migration 156: the SOLE-COPY body (the not-yet-seeded box)', () => {
  it('deletes NOTHING when no account row exists — the seed still needs every key', () => {
    const db = body({ googleKinds: [], msKinds: [] });
    apply(db);
    expect(surviving(db)).toEqual([...TOKEN_KEYS].sort());
    db.close();
  });

  it('does not abort the chain on that body — it declines, it does not refuse', () => {
    const db = body({ googleKinds: [], msKinds: [] });
    expect(() => apply(db)).not.toThrow();
    db.close();
  });
});

describe('PHASE-5 T10 migration 156: the MIXED body', () => {
  it('deletes per (provider, kind) — a seeded kind loses its pair, an unseeded one keeps it', () => {
    // Google agent seeded, Google user not. Microsoft user seeded, agent not.
    const db = body({ googleKinds: ['agent'], msKinds: ['user'] });
    apply(db);
    expect(surviving(db)).toEqual([
      'gws_user_access_token', 'gws_user_refresh_token',
      'ms_access_token', 'ms_refresh_token',
    ].sort());
    db.close();
  });

  it('an `agent` row does not authorise deleting the `user` keys (the prefix trap)', () => {
    // `gws_access_token` and `gws_user_access_token` differ by an infix, not a
    // prefix — a LIKE 'gws_%' shaped delete would take both.
    const db = body({ googleKinds: ['agent'], msKinds: [] });
    apply(db);
    expect(surviving(db)).toContain('gws_user_access_token');
    expect(surviving(db)).toContain('gws_user_refresh_token');
    expect(surviving(db)).not.toContain('gws_access_token');
    db.close();
  });
});

describe('PHASE-5 T10 migration 156: the FRESH-INSTALL body', () => {
  it('does nothing and aborts nothing when there are no legacy keys at all', () => {
    const db = body({ legacyTokens: false, googleKinds: ['agent'], msKinds: ['agent'] });
    expect(() => apply(db)).not.toThrow();
    expect(surviving(db)).toEqual([]);
    db.close();
  });

  it('does nothing and aborts nothing on a completely empty config', () => {
    const db = body({ legacyTokens: false });
    expect(() => apply(db)).not.toThrow();
    db.close();
  });
});

describe('PHASE-5 T10 migration 156: THE COUNTERFACTUAL — the guard removed', () => {
  /** The same file with the four `AND EXISTS (...)` guards stripped. */
  function guardStripped(): string {
    const stripped = SQL.replace(
      /\n\s*AND EXISTS \(SELECT 1 FROM (?:google|microsoft)_accounts WHERE kind = '(?:agent|user)'\)/g,
      '',
    );
    return stripped;
  }

  it('the strip actually removes all four guards (the probe is proven capable first)', () => {
    expect((SQL.match(/AND EXISTS \(SELECT 1 FROM/g) ?? [])).toHaveLength(4);
    expect(guardStripped().match(/AND EXISTS \(SELECT 1 FROM/g)).toBeNull();
  });

  it('WITHOUT the guard, the sole-copy body ABORTS the migration', () => {
    const db = body({ googleKinds: [], msKinds: [] });
    expect(() => apply(db, guardStripped())).toThrow(
      /migration_156_would_have_deleted_the_only_copy_of_a_sign_in_token|CHECK constraint failed/,
    );
    db.close();
  });

  it('the abort ROLLS BACK — not one legacy row is lost to the failed attempt', () => {
    const db = body({ googleKinds: [], msKinds: [] });
    try { apply(db, guardStripped()); } catch { /* expected */ }
    expect(surviving(db)).toEqual([...TOKEN_KEYS].sort());
    db.close();
  });

  it('WITHOUT the guard, the DUPLICATE body still passes — the refusal is scoped to real loss', () => {
    // The counterfactual must not fire on a body where the delete is correct;
    // a guard that bites wider than its requirement is one the next person removes.
    const db = body({ googleKinds: ['agent', 'user'], msKinds: ['agent', 'user'] });
    expect(() => apply(db, guardStripped())).not.toThrow();
    db.close();
  });

  it('WITHOUT the guard, the MIXED body aborts — it is the partial loss that matters', () => {
    const db = body({ googleKinds: ['agent'], msKinds: ['user'] });
    expect(() => apply(db, guardStripped())).toThrow();
    db.close();
  });
});

describe('PHASE-5 T10 migration 156: hygiene', () => {
  it('leaves no temp table behind on the connection', () => {
    const db = body({ googleKinds: ['agent', 'user'], msKinds: ['agent', 'user'] });
    apply(db);
    const temps = db.prepare("SELECT name FROM temp.sqlite_master WHERE name LIKE 't156%'").all();
    expect(temps).toEqual([]);
    db.close();
  });

  it('names the eight keys explicitly rather than by pattern', () => {
    // A `LIKE 'gws_%'` delete would also take gws_connected and gws_account_email,
    // which two live reader families still read.
    expect(SQL).not.toMatch(/LIKE\s+'(?:gws|ms)_/);
    for (const k of TOKEN_KEYS) expect(SQL).toContain(`'${k}'`);
  });
});
