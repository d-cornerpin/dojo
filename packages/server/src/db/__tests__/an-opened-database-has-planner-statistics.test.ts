// The one place that opens the database must leave SQLite with planner statistics,
// so a query on a long history does not have to guess row counts cold.
//
// The seed builds dojo.db by hand under the scratch HOME before the module imports,
// so getDb() opens a database that already has a table and an index to sample.
// Nothing here touches the live database.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite from 'better-sqlite3';
import type Database from 'better-sqlite3';

let scratchHome: string;
let db: Database.Database;
let closeDb: () => void;

beforeAll(async () => {
  scratchHome = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-planner-stats-'));
  vi.stubEnv('DOJO_HOME', scratchHome);
  vi.resetModules();
  const dataDir = path.join(scratchHome, '.dojo', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const seed = new BetterSqlite(path.join(dataDir, 'dojo.db'));
  seed.exec('CREATE TABLE probe (a INTEGER, b TEXT); CREATE INDEX probe_a ON probe(a);');
  const ins = seed.prepare('INSERT INTO probe (a, b) VALUES (?, ?)');
  for (let i = 0; i < 50; i++) ins.run(i, `row ${i}`);
  seed.close();
  const connection = await import('../connection.js');
  closeDb = connection.closeDb;
  db = connection.getDb();
  // Proof the redirect took: the module opened its database under the scratch HOME.
  expect(connection.getDbPath()).toBe(path.join(scratchHome, '.dojo', 'data', 'dojo.db'));
});

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('an opened database has planner statistics', () => {
  it('the statistics table exists after open', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get()).toEqual({ name: 'sqlite_stat1' });
  });

  it('the seeded table has its statistics row', () => {
    expect(db.prepare("SELECT tbl, idx FROM sqlite_stat1 WHERE tbl = 'probe'").get()).toEqual({ tbl: 'probe', idx: 'probe_a' });
  });
});
