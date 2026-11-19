// Two contacts who go by the same name: the name alone cannot say which one is meant, so it matches
// neither of them. A name only one contact has still matches that contact.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current! }));

import { recipientIdsMatch, resolveCanonicalRecipientId } from '../recipient-identity.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT,
      emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', imessage_handles TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
  `);
  const add = db.prepare('INSERT INTO contacts (id, display_name, preferred_name, phones) VALUES (?, ?, ?, ?)');
  add.run('c1', 'Sam One', 'Sam', '["+1 555 010 0001"]');
  add.run('c2', 'Sam Two', 'Sam', '["+1 555 010 0002"]');
  add.run('c3', 'Robin Example', 'Robin', '["+1 555 010 0003"]');
  mockDb.current = db;
});

describe('a name two contacts share', () => {
  it('matches neither contact', () => {
    expect(recipientIdsMatch('Sam', '+15550100001')).toBe(false);
    expect(recipientIdsMatch('Sam', '+15550100002')).toBe(false);
  });

  it('resolves to no identity', () => {
    expect(resolveCanonicalRecipientId('Sam')).toBeNull();
  });

  it('leaves a name one contact has, and every address, matching as before', () => {
    expect(recipientIdsMatch('Robin', '+15550100003')).toBe(true);
    expect(recipientIdsMatch('Sam One', '+1 (555) 010-0001')).toBe(true);
    expect(recipientIdsMatch('+1 555 010 0002', '5550100002')).toBe(true);
  });
});
