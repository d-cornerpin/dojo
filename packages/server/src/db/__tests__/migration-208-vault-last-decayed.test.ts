// Migration 208 on a database that already holds memories: every existing memory is stamped as just
// faded, so the update itself never costs a box a memory; nothing else about a row changes.
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
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-mig208-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('migration 208 on a database with memories', () => {
  it('stamps existing memories as just faded and leaves their confidence alone', () => {
    const db = mockDb.current!;
    db.exec('ALTER TABLE vault_entries DROP COLUMN last_decayed_at;');
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('a', 'A', 'idle')").run();
    db.prepare("INSERT INTO vault_entries (id, agent_id, type, content, confidence, created_at, updated_at) VALUES ('v1','a','fact','old',0.3,'2025-01-01 00:00:00','2025-01-01 00:00:00')").run();
    db.exec(readMigrationFile('208_vault_last_decayed.sql'));
    const row = db.prepare("SELECT confidence, last_decayed_at AS d FROM vault_entries WHERE id='v1'").get() as { confidence: number; d: string | null };
    expect(row.confidence).toBe(0.3);
    expect(row.d).not.toBeNull();
  });

  it('leaves a memory saved after the update unstamped', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('a', 'A', 'idle')").run();
    db.prepare("INSERT INTO vault_entries (id, agent_id, type, content, created_at, updated_at) VALUES ('v2','a','fact','new',datetime('now'),datetime('now'))").run();
    expect((db.prepare("SELECT last_decayed_at AS d FROM vault_entries WHERE id='v2'").get() as { d: string | null }).d).toBeNull();
  });
});
