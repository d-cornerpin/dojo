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

  it('refuses a write at its door, and SQLite refuses it again underneath the door', async () => {
    const door = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
    expect(door(() => ro.prepare("INSERT INTO t (v) VALUES ('x')").run())).toBe('DOJO_READ_ONLY_DOOR');
    expect(door(() => ro.exec('DROP TABLE t'))).toBe('DOJO_READ_ONLY_DOOR');
    // Underneath the door the handle is readonly: SQLite refuses the same write itself.
    const { default: Database } = await import('better-sqlite3');
    expect(door(() => Database.prototype.prepare.call(ro, "INSERT INTO t (v) VALUES ('x')").run())).toBe('SQLITE_READONLY');
    expect(door(() => Database.prototype.exec.call(ro, 'DROP TABLE t'))).toBe('SQLITE_READONLY');
    expect(main.prepare('SELECT count(*) FROM t').pluck().get()).toBe(1);
  });

  it('sets query_only and a busy timeout, read back because SQLite accepts bad values in silence', () => {
    expect(ro.prepare('SELECT * FROM pragma_query_only').pluck().get()).toBe(1);
    expect(ro.prepare('SELECT * FROM pragma_busy_timeout').pluck().get()).toBe(2000);
  });

  it('fix round 1: query_only cannot be turned off, nothing can be attached, and no copy can be written', () => {
    const copy = path.join(scratchHome, 'copy.db');
    for (const f of [
      () => ro.prepare('PRAGMA query_only = 0').run(),
      () => ro.pragma('query_only = 0'),
      () => ro.prepare(`VACUUM INTO '${copy}'`).run(),
      () => ro.exec(`VACUUM INTO '${copy}'`),
      () => ro.prepare(`ATTACH '${path.join(scratchHome, 'other.db')}' AS other`).run(),
      () => ro.prepare('WITH x AS (SELECT 1) DELETE FROM t').run(),
      () => ro.prepare('EXPLAIN PRAGMA query_only = 0').run(),
      () => ro.backup(copy),
      () => ro.loadExtension('x'),
    ]) expect(f).toThrow(/read-only connection/);
    expect(fs.existsSync(copy)).toBe(false);
    expect(ro.prepare('SELECT * FROM pragma_query_only').pluck().get()).toBe(1);
    expect(ro.prepare("SELECT count(*) FROM pragma_database_list WHERE name = 'other'").pluck().get()).toBe(0);
  });

  it('closeDb() closes both connections', () => {
    connection.closeDb();
    expect(ro.open).toBe(false);
    // Reopened lazily on the next ask, as the main connection is.
    ro = connection.getReadOnlyDb();
    expect(ro.open).toBe(true);
  });
});
