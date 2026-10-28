// The short id a contact tool prints is only the first 8 chars of a uuid. The
// get/update/forget tools must resolve that prefix to a contact no matter how
// long the store has grown, not just the 200 most recently updated.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import {
  executeContactGet,
  executeContactUpdate,
  executeContactForget,
} from '../tools.js';

const CREATE_CONTACTS =
  "CREATE TABLE contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT, emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', imessage_handles TEXT NOT NULL DEFAULT '[]', company TEXT, role TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', created_by_agent_id TEXT, last_updated_by_agent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))";

// 250 contacts, contact 250 newest and contact 1 oldest, so the 50 oldest sit
// outside the 200 most recently updated rows.
beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(CREATE_CONTACTS);
  const insert = db.prepare(
    "INSERT INTO contacts (id, display_name, updated_at) VALUES (?, ?, datetime('2026-01-01 00:00:00', '+' || ? || ' minutes'))",
  );
  for (let i = 1; i <= 250; i++) {
    insert.run(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, `Person ${i}`, i);
  }
  mockDb.current = db;
});

const rowCount = (): number =>
  (mockDb.current!.prepare('SELECT COUNT(*) as c FROM contacts').get() as { c: number }).c;

describe('contact short-id lookup', () => {
  it('opens an old contact by the 8-char id the tools print', () => {
    expect(executeContactGet({ contact_id: '00000001' })).toMatch(
      /^Contact: Person 1\nID: 00000001-0000-4000-8000-000000000000/,
    );
  });

  it('updates an old contact by short id', () => {
    expect(
      executeContactUpdate('agent-1', { contact_id: '00000002', company: 'Acme' }),
    ).toMatch(/^Contact updated/);
    const row = mockDb.current!.prepare('SELECT company FROM contacts WHERE id = ?')
      .get('00000002-0000-4000-8000-000000000000') as { company: string | null };
    expect(row.company).toBe('Acme');
  });

  it('forgets an old contact by short id', () => {
    const out = executeContactForget({ contact_id: '00000003' });
    expect(out).toContain('deleted');
    expect(rowCount()).toBe(249);
  });

  it('refuses an ambiguous prefix and changes nothing', () => {
    const before = rowCount();
    expect(executeContactForget({ contact_id: '0000' })).toBe('Error: no contact with id "0000".');
    expect(rowCount()).toBe(before);
  });

  it('still resolves the full id', () => {
    expect(
      executeContactGet({ contact_id: '00000250-0000-4000-8000-000000000000' }),
    ).toMatch(/^Contact: Person 250/);
  });

  it('reports an unknown prefix', () => {
    expect(executeContactGet({ contact_id: 'zzzz' })).toBe('Error: no contact with id "zzzz".');
  });

  it('treats a SQL wildcard as a literal, not a match-all', () => {
    expect(executeContactGet({ contact_id: '%' })).toBe('Error: no contact with id "%".');
  });
});
