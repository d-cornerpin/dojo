// Migration 207 on a database that ALREADY holds vectors: each existing vector is stamped with the
// embedding model configured now (the only one the box has known), or the defaults when nothing
// (or nothing readable) is saved; a vault entry with no vector stays unstamped.
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
  tmpDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-mig207-'));
  mockDb.current = new Database(path.join(tmpDir, 'dojo.db'));
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** The database as a release before 207 left it: no model column, vectors present. */
function legacy(config: string | null): Database.Database {
  const db = mockDb.current!;
  db.exec('ALTER TABLE embeddings DROP COLUMN embedding_model; ALTER TABLE vault_entries DROP COLUMN embedding_model;');
  db.prepare("DELETE FROM config WHERE key = 'embedding_config'").run();
  if (config !== null) db.prepare("INSERT INTO config (key, value) VALUES ('embedding_config', ?)").run(config);
  const vec = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
  db.prepare("INSERT INTO agents (id, name, status) VALUES ('a', 'A', 'idle')").run();
  db.prepare("INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions) VALUES ('e1','message','m1','a','p',?,4)").run(vec);
  db.prepare("INSERT INTO vault_entries (id, agent_id, type, content, embedding, created_at, updated_at) VALUES ('v1','a','fact','with vector',?,datetime('now'),datetime('now'))").run(vec);
  db.prepare("INSERT INTO vault_entries (id, agent_id, type, content, created_at, updated_at) VALUES ('v2','a','fact','no vector',datetime('now'),datetime('now'))").run();
  return db;
}
const stamps = (db: Database.Database) => ({
  e: (db.prepare("SELECT embedding_model AS m FROM embeddings WHERE id='e1'").get() as { m: string | null }).m,
  v1: (db.prepare("SELECT embedding_model AS m FROM vault_entries WHERE id='v1'").get() as { m: string | null }).m,
  v2: (db.prepare("SELECT embedding_model AS m FROM vault_entries WHERE id='v2'").get() as { m: string | null }).m,
});

describe('migration 207 on a database with vectors', () => {
  it('stamps them with the configured model', () => {
    const db = legacy(JSON.stringify({ provider: 'openai', model: 'text-embed-x' }));
    db.exec(readMigrationFile('207_embedding_model.sql'));
    expect(stamps(db)).toEqual({ e: 'openai:text-embed-x', v1: 'openai:text-embed-x', v2: null });
  });
  it('stamps them with the defaults when nothing is saved', () => {
    const db = legacy(null);
    db.exec(readMigrationFile('207_embedding_model.sql'));
    expect(stamps(db)).toEqual({ e: 'ollama:nomic-embed-text', v1: 'ollama:nomic-embed-text', v2: null });
  });
  it('stamps them with the defaults when the saved settings are not readable', () => {
    const db = legacy('{not json');
    db.exec(readMigrationFile('207_embedding_model.sql'));
    expect(stamps(db)).toEqual({ e: 'ollama:nomic-embed-text', v1: 'ollama:nomic-embed-text', v2: null });
  });
});
