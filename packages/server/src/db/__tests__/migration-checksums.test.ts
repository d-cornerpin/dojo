// PHASE-2 T10 — RULING 7 rider (a): `_migrations` records WHAT it applied, and a
// boot-time audit says so out loud when the file on disk no longer matches.
//
// The incident this exists for (MAP-TRIAGE, 2026-07-29): migration `139` was applied
// from an in-progress working tree missing a clause; the author fixed the file 42
// seconds later; `_migrations` records NAME ONLY, so the corrected file was already
// "applied" and never re-ran. The box carried a trigger that exists nowhere in the
// repo for six hours, aborting every fan-out piece landing, and the only signal was a
// swallowed `warn`. A name is not evidence of what ran.
//
// The audit is a REPORT, never a refusal — see `auditMigrationChecksums`' header for
// the Bridge author's story and why refusing the boot is the wrong tier.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  migrationChecksum,
  ensureMigrationChecksumColumn,
  auditMigrationChecksums,
} from '../migration-checksums.js';

let dir: string;
let db: Database.Database;

const record = (name: string, checksum: string | null): void => {
  db.prepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)').run(name, checksum);
};
const writeFile = (name: string, sql: string): void => {
  fs.writeFileSync(path.join(dir, name), sql, 'utf-8');
};
/** The reader the chain runner injects, pointed at this test's scratch directory. */
const read = (name: string): string | null => {
  try { return fs.readFileSync(path.join(dir, name), 'utf-8'); } catch { return null; }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-migchk-'));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrationChecksum', () => {
  it('is stable and content-addressed', () => {
    expect(migrationChecksum('SELECT 1;')).toBe(migrationChecksum('SELECT 1;'));
    expect(migrationChecksum('SELECT 1;')).not.toBe(migrationChecksum('SELECT 2;'));
    // 64 hex chars — sha256.
    expect(migrationChecksum('SELECT 1;')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores line-ending churn only', () => {
    // A CRLF checkout must not cry wolf; a changed CLAUSE must.
    expect(migrationChecksum('A;\r\nB;\r\n')).toBe(migrationChecksum('A;\nB;\n'));
    expect(migrationChecksum('A;\nB;\n')).not.toBe(migrationChecksum('A;\nB2;\n'));
  });
});

describe('ensureMigrationChecksumColumn', () => {
  it('adds the column to a pre-existing _migrations table and is idempotent', () => {
    const cols = () => (db.prepare('PRAGMA table_info(_migrations)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols()).not.toContain('checksum');
    ensureMigrationChecksumColumn(db);
    expect(cols()).toContain('checksum');
    // Second call on an already-migrated table must not throw (every boot calls it).
    ensureMigrationChecksumColumn(db);
    expect(cols()).toContain('checksum');
  });

  it('leaves already-applied rows unverifiable rather than inventing a checksum for them', () => {
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run('001_old.sql');
    ensureMigrationChecksumColumn(db);
    const row = db.prepare('SELECT checksum FROM _migrations WHERE name = ?').get('001_old.sql') as
      { checksum: string | null };
    expect(row.checksum).toBeNull();
  });
});

describe('auditMigrationChecksums', () => {
  beforeEach(() => ensureMigrationChecksumColumn(db));

  it('THE INCIDENT: a file edited after it was applied is reported as diverged, naming the file', () => {
    writeFile('139_two_key_completion.sql', 'CREATE TRIGGER t ... root_kind <> \'a2a_thread\' ...;');
    // Recorded from the in-progress tree — the clause the author added 42s later is missing.
    record('139_two_key_completion.sql', migrationChecksum('CREATE TRIGGER t ...;'));

    const audit = auditMigrationChecksums(db, read);

    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0].kind).toBe('diverged');
    expect(audit.findings[0].file).toBe('139_two_key_completion.sql');
    expect(audit.findings[0].recorded).toBe(migrationChecksum('CREATE TRIGGER t ...;'));
    expect(audit.findings[0].actual)
      .toBe(migrationChecksum('CREATE TRIGGER t ... root_kind <> \'a2a_thread\' ...;'));
    expect(audit.verified).toBe(0);
  });

  it('a matching file is verified and produces no finding', () => {
    const sql = 'ALTER TABLE work ADD COLUMN drain_stuck INTEGER;';
    writeFile('140_x.sql', sql);
    record('140_x.sql', migrationChecksum(sql));

    const audit = auditMigrationChecksums(db, read);
    expect(audit.findings).toEqual([]);
    expect(audit.verified).toBe(1);
    expect(audit.unverifiable).toBe(0);
  });

  it('rows applied before checksums existed are UNVERIFIABLE, not diverged', () => {
    // Every row on every box that exists today. Absence of a checksum is a question,
    // never a verdict (#15).
    writeFile('001_old.sql', 'anything at all');
    record('001_old.sql', null);

    const audit = auditMigrationChecksums(db, read);
    expect(audit.findings).toEqual([]);
    expect(audit.unverifiable).toBe(1);
    expect(audit.verified).toBe(0);
  });

  it('a recorded migration whose FILE IS GONE is superseded, a lower tier than diverged', () => {
    // The Bridge case: a release folds/renames files. The box is not wrong; the file moved.
    record('129b_stable_merge_messages.sql', migrationChecksum('anything'));

    const audit = auditMigrationChecksums(db, read);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0].kind).toBe('superseded');
    expect(audit.findings[0].actual).toBeNull();
  });

  it('reports EVERY divergence, not the first', () => {
    writeFile('140_a.sql', 'a2');
    writeFile('141_b.sql', 'b2');
    record('140_a.sql', migrationChecksum('a1'));
    record('141_b.sql', migrationChecksum('b1'));

    const audit = auditMigrationChecksums(db, read);
    expect(audit.findings.map(f => f.file)).toEqual(['140_a.sql', '141_b.sql']);
  });

  it('never throws when the migrations directory is missing', () => {
    record('140_a.sql', migrationChecksum('a1'));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => auditMigrationChecksums(db, read)).not.toThrow();
  });

  it('is a REPORT: it returns findings and does not refuse anything', () => {
    // The refusal-tier decision, pinned as a test so it cannot drift silently.
    // A lived-in box whose files were legitimately superseded must still boot.
    writeFile('140_a.sql', 'a2');
    record('140_a.sql', migrationChecksum('a1'));
    expect(() => auditMigrationChecksums(db, read)).not.toThrow();
    expect(auditMigrationChecksums(db, read).findings).toHaveLength(1);
  });
});
