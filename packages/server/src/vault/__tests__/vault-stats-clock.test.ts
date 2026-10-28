// ════════════════════════════════════════
// getVaultStats "Retrieved Today": the vault's timestamps are UTC text in
// SQLite's datetime('now') shape ('YYYY-MM-DD HH:MM:SS'), so binding a JS
// toISOString() ('...T...Z') against them compares two clock shapes as plain
// text and the space before the hour sorts before 'T'. The tile must count
// entries retrieved since the owner's local midnight, whatever the zone.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  // t98: the vault's reads route through the reader pool, which asks the connection module WHERE
  // the database is. These clauses run against ':memory:', which no second connection can reach,
  // so the pool declines itself and every read runs on this connection — the honest answer.
  getDbPath: () => ':memory:',
}));

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vault_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 1.0,
      is_permanent INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0,
      is_obsolete INTEGER DEFAULT 0,
      superseded_by TEXT,
      retrieval_count INTEGER DEFAULT 0,
      last_retrieved_at TEXT,
      source_conversation_id TEXT,
      source TEXT DEFAULT 'agent',
      citation TEXT,
      embedding BLOB,
      namespace TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_conversations (id TEXT PRIMARY KEY, is_processed INTEGER DEFAULT 0, poisoned INTEGER DEFAULT 0);
    CREATE TABLE dream_reports (id TEXT PRIMARY KEY, created_at TEXT);
  `);
  mockDb.current = db;
  // Local 2026-10-27 15:00 on the test machine, so the case holds in any zone.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 15, 0, 0));
});

afterEach(() => vi.useRealTimers());

import { getVaultStats } from '../store.js';

function insertLiveEntry(id: string, lastRetrievedAt: string | null): void {
  mockDb.current!
    .prepare('INSERT INTO vault_entries (id, agent_id, content, is_obsolete, last_retrieved_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, 'test-agent', `entry ${id}`, lastRetrievedAt);
}

describe('getVaultStats retrievedToday (mixed clock text)', () => {
  it('counts an entry retrieved earlier on the same local day', () => {
    insertLiveEntry('today', new Date(2026, 9, 27, 9).toISOString().slice(0, 19).replace('T', ' '));
    insertLiveEntry('yesterday', new Date(2026, 9, 26, 23).toISOString().slice(0, 19).replace('T', ' '));
    insertLiveEntry('never', null);
    expect(getVaultStats().retrievedToday).toBe(1);
  });

  it('counts an entry retrieved minutes after local midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 27, 0, 30, 0));
    insertLiveEntry('just-after-midnight', new Date(2026, 9, 27, 0, 10).toISOString().slice(0, 19).replace('T', ' '));
    insertLiveEntry('yesterday', new Date(2026, 9, 26, 23).toISOString().slice(0, 19).replace('T', ' '));
    insertLiveEntry('never', null);
    expect(getVaultStats().retrievedToday).toBe(1);
  });
});
