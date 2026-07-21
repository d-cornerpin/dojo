// P5c: canonical recipient identity (rekey of the D16 last-10-digits fuzz).
// Identity comes from the contacts / safe-sender stores; the digit-tail
// heuristic survives only as the both-unknown fallback.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { recipientIdsMatch, resolveCanonicalRecipientId } from '../recipient-identity.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      preferred_name TEXT,
      emails TEXT NOT NULL DEFAULT '[]',
      phones TEXT NOT NULL DEFAULT '[]',
      imessage_handles TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(`INSERT INTO contacts (id, display_name, preferred_name, emails, phones, imessage_handles)
              VALUES ('c1', 'Pat Example', 'Pat', '["pat@example.com"]', '["+1 (555) 123-4567"]', '["pat@example.com"]')`).run();
  db.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: '+15559990000', name: 'Sky', is_primary: true }]));
  mockDb.current = db;
});

describe('resolveCanonicalRecipientId', () => {
  it('resolves a contact by phone (any formatting), email, handle, and name to ONE id', () => {
    expect(resolveCanonicalRecipientId('5551234567')).toBe('contact:c1');
    expect(resolveCanonicalRecipientId('+1-555-123-4567')).toBe('contact:c1');
    expect(resolveCanonicalRecipientId('PAT@example.com')).toBe('contact:c1');
    expect(resolveCanonicalRecipientId('Pat')).toBe('contact:c1');
    expect(resolveCanonicalRecipientId('pat example')).toBe('contact:c1');
  });

  it('resolves a safe sender by address or name', () => {
    expect(resolveCanonicalRecipientId('+1 555 999 0000')).toBe('im:15559990000');
    expect(resolveCanonicalRecipientId('Sky')).toBe('im:15559990000');
  });

  it('returns null for an unknown recipient', () => {
    expect(resolveCanonicalRecipientId('nobody@example.com')).toBeNull();
  });
});

describe('recipientIdsMatch', () => {
  it('matches a contact name against its phone number (identity, not string, equality)', () => {
    expect(recipientIdsMatch('Pat', '+1 (555) 123-4567')).toBe(true);
    expect(recipientIdsMatch('pat@example.com', '5551234567')).toBe(true);
  });

  it('does NOT match two different known identities that share nothing', () => {
    expect(recipientIdsMatch('Pat', 'Sky')).toBe(false);
    expect(recipientIdsMatch('pat@example.com', '+15559990000')).toBe(false);
  });

  it('keeps exact and digit-tail tolerance for addresses no store knows', () => {
    expect(recipientIdsMatch('who@example.net', 'who@example.net')).toBe(true);
    expect(recipientIdsMatch('+1 (555) 777-8888', '5557778888')).toBe(true);
    expect(recipientIdsMatch('a-b@x.com', 'ab@x.com')).toBe(false);
  });

  it('degrades to string compares when the store is unavailable (never throws)', () => {
    mockDb.current = null;
    expect(recipientIdsMatch('+1 (555) 123-4567', '5551234567')).toBe(true);
    expect(recipientIdsMatch('Pat', '+15551234567')).toBe(false);
  });
});
