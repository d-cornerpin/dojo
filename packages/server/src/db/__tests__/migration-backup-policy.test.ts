// ════════════════════════════════════════════════════════════════════════════════
// SWEEP-A RESTORE-PATH JOB 2 — THE PRE-MIGRATION BACKUP STOPS BEING SILENT, AND A
// CHAIN THAT CANNOT BE UNDONE STOPS RUNNING WITHOUT ONE.
//
// Two defects, one function.
//
//   (a) NOBODY WAS TOLD. Written was `logger.info`, which the broadcast gate never
//       forwards at all; skipped and failed were `logger.warn`/`logger.error`, which
//       would qualify — except both fire ~630 lines before the broadcast callback is
//       installed, so in practice all three outcomes were a line in a file the owner
//       does not read. The one fact that decides whether an update can be undone was
//       unreachable from every surface the product has.
//
//   (b) A CHAIN RAN ANYWAY. The disk guard skipped the snapshot below 2x the database
//       size and returned; the outer catch swallowed any write failure. Either way the
//       whole migration chain then applied with NO restore point — which is precisely
//       the shape that leaves a person with a changed database and no way back. The
//       pre-migration backup is the ENTIRE stated justification for the deliberate
//       no-rollback-after-migrations policy; running the chain without one runs the
//       policy without its premise.
//
// So: the outcome is recorded durably where a route can read it, and a chain that
// would run with no restore point REFUSES — with an override for the person who
// decides that going forward matters more than being able to go back.
//
// The refusal is deliberately NOT universal, and the last two clauses are the scope:
// a database with nothing applied yet has nothing to lose and is never held up, and a
// connection with no file on disk is never in scope at all.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { current: null as Database.Database | null },
}));

vi.mock('../connection.js', async () => {
  const actual = await vi.importActual<typeof import('../connection.js')>('../connection.js');
  return {
    ...actual,
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
  };
});

import { runMigrations } from '../migrations.js';
import {
  ensurePreChainBackup,
  readLastMigrationBackup,
  MigrationBackupRequiredError,
  MIGRATION_BACKUP_OVERRIDE_FILE,
  MIGRATION_BACKUP_OVERRIDE_ENV,
} from '../migration-backup.js';

/** A chain of two files with the first already applied — i.e. a body with something to lose. */
const FILES_WITH_HISTORY = ['001_first.sql', '002_second.sql'];
const PENDING_WITH_HISTORY = ['002_second.sql'];
/** A chain where nothing has been applied yet — a fresh install. */
const FILES_FRESH = ['001_first.sql', '002_second.sql'];
const PENDING_FRESH = ['001_first.sql', '002_second.sql'];

describe('pre-migration backup: what it says, and what it refuses', () => {
  let scratch: string;
  let dbFile: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-backup-policy-'));
    dbFile = path.join(scratch, 'dojo.db');
  });

  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Blocks the backups directory by occupying its path with a plain file. */
  function blockBackupsDir(): void {
    fs.writeFileSync(path.join(scratch, 'backups'), 'not a directory');
  }

  /** A database whose config table exists, as runMigrations guarantees before the chain. */
  function openDb(): Database.Database {
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    mockDb.current = db;
    return db;
  }

  it('records a WRITTEN backup where a surface can read it', () => {
    const db = openDb();

    ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY);

    const outcome = readLastMigrationBackup(db);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('written');
    // The record names a file that is really there, at the size it claims.
    expect(fs.existsSync(outcome!.path!)).toBe(true);
    expect(fs.statSync(outcome!.path!).size).toBe(outcome!.bytes);
    expect(path.dirname(outcome!.path!)).toBe(path.join(scratch, 'backups'));
    expect(outcome!.pendingMigrations).toBe(1);
    expect(outcome!.overridden).toBe(false);
    expect(outcome!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('through the real entry point, a FIRST RUN records why there is no restore point', () => {
    // The whole-chain path, driven end to end: a brand-new body applies 100+ migrations
    // and records `not-applicable` rather than snapshotting an empty database — which is
    // what produced the useless `dojo-pre-0-to-900-*.db` files this box was littered with.
    mockDb.current = new Database(dbFile);

    runMigrations();

    const applied = mockDb.current.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number };
    expect(applied.c).toBeGreaterThan(100);

    const outcome = readLastMigrationBackup(mockDb.current);
    expect(outcome!.status).toBe('not-applicable');
    expect(outcome!.reason).toContain('first run');
    expect(fs.existsSync(path.join(scratch, 'backups'))).toBe(false);
  });

  it('REFUSES the chain when the snapshot cannot be written and there is data to lose', () => {
    const db = openDb();
    blockBackupsDir();

    expect(() => ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY))
      .toThrow(MigrationBackupRequiredError);

    const outcome = readLastMigrationBackup(db);
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe('failed');
    expect(outcome!.overridden).toBe(false);
  });

  it('the refusal message names the override and the directory it is about', () => {
    const db = openDb();
    blockBackupsDir();

    let message = '';
    try {
      ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain(path.join(scratch, MIGRATION_BACKUP_OVERRIDE_FILE));
    expect(message).toContain('1 database migration');
  });

  it('the override FILE lets it through — and is consumed, so it cannot linger', () => {
    const db = openDb();
    blockBackupsDir();
    const overridePath = path.join(scratch, MIGRATION_BACKUP_OVERRIDE_FILE);
    fs.writeFileSync(overridePath, '');

    expect(() => ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY)).not.toThrow();

    const outcome = readLastMigrationBackup(db);
    expect(outcome!.status).toBe('failed');
    expect(outcome!.overridden).toBe(true);
    // One-shot: a permission granted once is not a permission granted forever.
    expect(fs.existsSync(overridePath)).toBe(false);
  });

  it('the override ENV lets it through', () => {
    const db = openDb();
    blockBackupsDir();
    vi.stubEnv(MIGRATION_BACKUP_OVERRIDE_ENV, '1');

    expect(() => ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY)).not.toThrow();
    expect(readLastMigrationBackup(db)!.overridden).toBe(true);
  });

  it('SCOPE: a database with nothing applied yet is never held up', () => {
    const db = openDb();
    blockBackupsDir();

    // A fresh install has no restore point worth having and must never be refused
    // a first boot over one. This clause is what stops the refusal bricking a new box.
    expect(() => ensurePreChainBackup(db, FILES_FRESH, PENDING_FRESH)).not.toThrow();

    const outcome = readLastMigrationBackup(db);
    expect(outcome!.status).toBe('not-applicable');
  });

  it('SCOPE: a connection with no file on disk is never in scope', () => {
    const db = new Database(':memory:');
    mockDb.current = db;
    db.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);

    expect(() => ensurePreChainBackup(db, FILES_WITH_HISTORY, PENDING_WITH_HISTORY)).not.toThrow();
    expect(readLastMigrationBackup(db)!.status).toBe('not-applicable');
  });
});
