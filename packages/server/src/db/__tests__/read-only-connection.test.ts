// v3.5 inspect A1 — the second connection every dojo_inspect view reads through.
//
// The requirement is that a write is refused BY SQLITE, not by a parser of ours: the
// connection is opened `readonly` and `query_only` is set on top, so even a statement our
// own checks wrongly let through cannot change a byte. This drives the real module against a
// scratch DOJO_HOME (the same redirect connection-pragmas.test.ts uses), never the live box.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

let scratchHome: string;
let main: Database.Database;
let ro: Database.Database;
let connection: typeof import('../connection.js');

beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-ro-conn-'));
  vi.stubEnv('DOJO_HOME', scratchHome);
  vi.resetModules();
  connection = await import('../connection.js');
  main = connection.getDb();
  main.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  main.prepare('INSERT INTO t (v) VALUES (?)').run('written by the engine');
  ro = connection.getReadOnlyDb();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('getReadOnlyDb() — a second connection that cannot write', () => {
  it('is a different connection on the same file, opened once per process', () => {
    expect(ro).not.toBe(main);
    expect(connection.getReadOnlyDb()).toBe(ro);
    expect(ro.name).toBe(connection.getDbPath());
    expect(ro.readonly).toBe(true);
  });

  it('reads what the engine wrote', () => {
    expect(ro.prepare('SELECT v FROM t').pluck().get()).toBe('written by the engine');
  });

  it('refuses a write with SQLITE_READONLY — SQLite refuses it, not a parser', () => {
    let code: string | undefined;
    try { ro.prepare("INSERT INTO t (v) VALUES ('x')").run(); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('SQLITE_READONLY');
    let ddl: string | undefined;
    try { ro.exec('DROP TABLE t'); } catch (e) { ddl = (e as { code?: string }).code; }
    expect(ddl).toBe('SQLITE_READONLY');
    expect(main.prepare('SELECT count(*) FROM t').pluck().get()).toBe(1);
  });

  it('sets query_only and a busy timeout, read back because SQLite accepts bad values in silence', () => {
    expect(ro.pragma('query_only', { simple: true })).toBe(1);
    expect(ro.pragma('busy_timeout', { simple: true })).toBe(2000);
  });

  it('closeDb() closes both connections', () => {
    connection.closeDb();
    expect(ro.open).toBe(false);
    // Reopened lazily on the next ask, as the main connection is.
    ro = connection.getReadOnlyDb();
    expect(ro.open).toBe(true);
  });
});
