// In-memory contacts store: a LIKE search whose query contains a backslash must
// match the literal backslash, not treat it as the SQL escape marker. Mirrors
// the recipient-identity in-memory DB idiom (vi.mock getDb + a :memory: db).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { searchContacts, countContacts } from '../store.js';

beforeEach(() => {
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
  // c1's notes really contain a backslash (C:\Temp); c2 does not (C:Temp).
  db.prepare(`INSERT INTO contacts (id, display_name, notes) VALUES ('c1', 'Pat Example', 'share drive is C:\\Temp\\reports')`).run();
  db.prepare(`INSERT INTO contacts (id, display_name, notes) VALUES ('c2', 'Sam Sample', 'share drive is C:Temp reports')`).run();
  db.prepare(`INSERT INTO contacts (id, display_name, notes) VALUES ('c3', 'Lee Other', '100% sure')`).run();
  mockDb.current = db;
});

describe('contacts LIKE search escapes the backslash as well as % and _', () => {
  it('a backslash in the query matches a literal backslash, not an escaped char', () => {
    // C:\Temp must find c1 (notes contain C:\Temp), not c2 (notes hold C:Temp).
    expect(searchContacts('C:\\Temp').map(r => r.id)).toEqual(['c1']);
    expect(countContacts('C:\\Temp')).toBe(1);
  });

  it('a trailing backslash does not absorb the closing % wildcard', () => {
    expect(searchContacts('Temp\\').map(r => r.id)).toEqual(['c1']);
    expect(countContacts('Temp\\')).toBe(1);
  });

  it('the % escape still works (regression guard)', () => {
    expect(searchContacts('100%').map(r => r.id)).toEqual(['c3']);
    expect(countContacts('100%')).toBe(1);
  });
});
