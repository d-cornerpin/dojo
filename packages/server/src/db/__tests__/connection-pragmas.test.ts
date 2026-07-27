// PHASE-0 T12c Step 3 — the connection's pragmas are set where the connection
// is opened, and they are what we think they are.
//
// getDb() is the single place the platform opens its own database
// (`grep -ranI "new Database(" packages/server/src packages/shared/src` at
// 8eb4c58: five non-test matches — this one, two migration-import paths that
// open a DIFFERENT file by argument, and two readonly opens of Apple's chat.db).
// So every statement the server runs inherits exactly these settings, and a
// readback is the only honest way to say so: `PRAGMA cache_size = -32000` is
// silently ignored on a bad value and SQLite caps mmap_size at its compile-time
// maximum without complaining.
//
// The test drives the real module, not a hand-built connection, by pointing HOME
// at a scratch directory before importing it — connection.ts derives its path
// from os.homedir(), which on POSIX is $HOME. Nothing here touches the live
// database.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let scratchHome: string;
let db: Database.Database;
let closeDb: () => void;

beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-pragmas-'));
  vi.stubEnv('HOME', scratchHome);
  vi.resetModules();
  const connection = await import('../connection.js');
  closeDb = connection.closeDb;
  db = connection.getDb();
  // Proof the redirect took: the module opened its database under the scratch
  // HOME, so these readings describe the real getDb() path and not the live box.
  expect(connection.getDbPath()).toBe(path.join(scratchHome, '.dojo', 'data', 'dojo.db'));
});

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('getDb() opens the connection with the pragmas the platform relies on', () => {
  it('keeps a page cache larger than the whole database', () => {
    // Negative = KiB rather than pages: 32 MB, about twice the live database at
    // the time of writing, so the working set does not get evicted.
    expect(db.pragma('cache_size', { simple: true })).toBe(-32000);
  });

  it('maps the database file into memory instead of read()ing page by page', () => {
    expect(db.pragma('mmap_size', { simple: true })).toBe(268435456);
  });

  it('keeps temporary b-trees in memory', () => {
    // 2 = MEMORY. Sorts and GROUP BY spills stay in RAM instead of writing a
    // temp file next to the database.
    expect(db.pragma('temp_store', { simple: true })).toBe(2);
  });

  it('still sets the two pragmas that were already load-bearing', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
