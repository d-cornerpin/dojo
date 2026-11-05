// Migration 212 (v3.5 field fix 3, owner ruling verbatim: "I was very clear that there was not to be a
// summarization/compaction model setting and that each agents own model would do the compaction summarization."):
// a lived-in box's `compaction_model_id` row is deleted, once and idempotently; no other config row moves.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:', closeDb: vi.fn() }));

import { runMigrations, readMigrationFile } from '../migrations.js';

const FILE = '212_no_summary_writer_setting.sql';
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-mig212-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(tmpDir, { recursive: true, force: true }); });

const value = (key: string): string | undefined =>
  (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value;

describe('migration 212 on a box that carries the old summary-writer setting', () => {
  it('deletes the compaction_model_id row and leaves every other row alone, and a second run changes nothing', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'some-model') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.prepare("INSERT INTO config (key, value) VALUES ('dojo_fallback_vision_model_id', 'vision-model') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.exec(readMigrationFile(FILE));
    expect(value('compaction_model_id')).toBeUndefined();
    expect(value('dojo_fallback_vision_model_id')).toBe('vision-model');
    db.exec(readMigrationFile(FILE));
    expect(value('compaction_model_id')).toBeUndefined();
    expect(value('dojo_fallback_vision_model_id')).toBe('vision-model');
  });
});
