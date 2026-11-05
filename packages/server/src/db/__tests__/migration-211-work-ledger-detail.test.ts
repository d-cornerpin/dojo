// Migration 211 on a database whose ledger already holds entries: a nullable `detail` column is added
// (a command's exit status, v3.5 field fix 3) and every existing entry keeps its key, tool and clocks.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../connection.js', () => ({
  getDb: () => mockDb.current!,
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations, readMigrationFile } from '../migrations.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-mig211-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('migration 211 on a ledger with entries', () => {
  it('adds a nullable detail column and leaves every existing entry as it was', () => {
    const db = mockDb.current!;
    db.exec('ALTER TABLE work_ledger DROP COLUMN detail;');
    db.prepare("INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at) VALUES ('w1','task','a','agent','a','tracker','w1','claimed','tracker',0,0,'t',1700000000000,1700000000000)").run();
    db.prepare("INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at) VALUES ('w1', 'gmail:msg:m1', 'gmail_label', 10, 20)").run();
    db.exec(readMigrationFile('211_work_ledger_detail.sql'));
    expect(db.prepare("SELECT work_id, item_key, tool, first_at, last_at, detail FROM work_ledger").all())
      .toEqual([{ work_id: 'w1', item_key: 'gmail:msg:m1', tool: 'gmail_label', first_at: 10, last_at: 20, detail: null }]);
  });
});
