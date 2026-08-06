// ════════════════════════════════════════════════════════════════════════════════
// SWEEP-A RESTORE-PATH JOB 3 — THE PRE-MIGRATION BACKUP WRITES BESIDE THE DATABASE
// IT SNAPSHOTS, AND NOWHERE ELSE.
//
// The defect this file exists for, reproduced on the real dev box before the fix:
// `backupBeforeMigrationChain` chose its output directory from `getDbPath()` — a
// module-global derived from `$HOME` at import time — while snapshotting whatever
// connection `getDb()` handed it. Those are two different things the moment a test
// substitutes the connection, and the function then wrote a snapshot of a throwaway
// test database into the OWNER'S `~/.dojo/data/backups`, where the keep-newest-2
// prune promptly evicted his genuine restore points. Two shapes, both live:
//
//   * a test that mocks `getDb` but spreads `...actual` for the rest, so `getDbPath()`
//     still answers the real home directory;
//   * a test that stubs `getDbPath: () => ':memory:'`, where `path.dirname(':memory:')`
//     is `'.'` and the junk lands in the repo working tree instead.
//
// The fix is not "mock one more function in each test". It is that a backup belongs
// beside the database it is a backup OF: the destination now comes from the
// connection's own file (`db.name`), and a connection with no file on disk is not
// snapshotted at all. Production behaviour is unchanged — clause 3 pins that the two
// paths agree there — and no test can reach the owner's data directory by omission.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { current: null as Database.Database | null },
}));

// DELIBERATELY the leaking shape: `getDb` is replaced, `getDbPath` is left as the
// real module's — exactly what the two contract tests do. If the backup destination
// is ever taken from `getDbPath()` again, these clauses fail.
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
import { getDbPath } from '../connection.js';

/** Every `dojo-pre-*.db` under a directory, or [] when the directory does not exist. */
function restorePoints(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.startsWith('dojo-pre-') && f.endsWith('.db')).sort();
  } catch {
    return [];
  }
}

describe('pre-migration backup: destination', () => {
  const realBackupsDir = path.join(path.dirname(getDbPath()), 'backups');
  const cwdBackupsDir = path.join(process.cwd(), 'backups');
  let scratch: string;
  let before: { real: string[]; cwd: string[] };

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-backup-loc-'));
    before = { real: restorePoints(realBackupsDir), cwd: restorePoints(cwdBackupsDir) };
  });

  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('writes NOTHING when the connection has no file on disk (:memory:)', () => {
    mockDb.current = new Database(':memory:');

    runMigrations();

    // The chain really ran — this is not a vacuous pass.
    const applied = mockDb.current.prepare('SELECT COUNT(*) AS c FROM _migrations').get() as { c: number };
    expect(applied.c).toBeGreaterThan(100);

    // And it wrote no snapshot anywhere a person's data lives.
    expect(restorePoints(realBackupsDir)).toEqual(before.real);
    expect(restorePoints(cwdBackupsDir)).toEqual(before.cwd);
  });

  it('writes beside the database it snapshots, not beside getDbPath()', () => {
    const dbFile = path.join(scratch, 'dojo.db');
    mockDb.current = new Database(dbFile);

    runMigrations();

    const mine = restorePoints(path.join(scratch, 'backups'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatch(/^dojo-pre-\d+-to-\d+-.*\.db$/);

    // A real snapshot, openable and consistent.
    const snap = new Database(path.join(scratch, 'backups', mine[0]!), { readonly: true });
    try {
      expect(snap.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      snap.close();
    }

    // The owner's directory and the repo tree are untouched.
    expect(restorePoints(realBackupsDir)).toEqual(before.real);
    expect(restorePoints(cwdBackupsDir)).toEqual(before.cwd);
  });

  it('in production the connection and getDbPath() name the same file', async () => {
    // Drives the REAL connection module under a scratch HOME — the convention
    // `db/__tests__/connection-pragmas.test.ts` established. This is the clause that
    // says the fix changed nothing on the owner's box: on a real boot the snapshot
    // still lands in `<home>/.dojo/data/backups`.
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-backup-home-'));
    try {
      vi.stubEnv('HOME', scratchHome);
      vi.resetModules();
      const connection = await vi.importActual<typeof import('../connection.js')>('../connection.js');
      const db = connection.getDb();
      try {
        expect(db.name).toBe(connection.getDbPath());
        expect(path.dirname(db.name)).toBe(path.join(scratchHome, '.dojo', 'data'));
      } finally {
        connection.closeDb();
      }
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(scratchHome, { recursive: true, force: true });
    }
  });
});
