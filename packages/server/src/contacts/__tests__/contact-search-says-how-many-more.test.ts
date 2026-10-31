import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { executeContactSearch, executeContactList } from '../tools.js';

function seed(n: number) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      preferred_name TEXT,
      emails TEXT NOT NULL DEFAULT '[]',
      phones TEXT NOT NULL DEFAULT '[]',
      imessage_handles TEXT NOT NULL DEFAULT '[]',
      company TEXT,
      role TEXT,
      notes TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_by_agent_id TEXT,
      last_updated_by_agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  for (let i = 1; i <= n; i++) {
    db.prepare('INSERT INTO contacts (id, display_name) VALUES (?, ?)').run(`c${i}`, `Test Person ${i}`);
  }
  mockDb.current = db;
}

describe('contact tools say how many more there are', () => {
  beforeEach(() => seed(25));

  it('search: partial page reports the real total', () => {
    const out = executeContactSearch({ query: 'Test Person', limit: 10 });
    expect(out).toContain('Showing 10 of 25');
  });
  it('list: partial page reports the real total and the next offset', () => {
    const out = executeContactList({ limit: 10 });
    expect(out).toContain('Showing 10 of 25');
    expect(out).toContain('Pass offset=10 to see more.');
  });
  it('everything fits: old wording', () => {
    seed(5);
    expect(executeContactSearch({ query: 'Test Person', limit: 10 })).toContain('5 contact(s) matching');
    expect(executeContactSearch({ query: 'Test Person', limit: 10 })).not.toContain('Showing');
    expect(executeContactList({ limit: 10 })).toContain('5 contact(s) (sorted by updated)');
  });
});
