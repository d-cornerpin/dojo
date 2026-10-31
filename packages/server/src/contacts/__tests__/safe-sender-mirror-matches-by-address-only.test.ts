// The safe-sender mirror matches a contact by ADDRESS only and never replaces an owner-set name.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { syncSafeSendersToContacts } from '../from-safe-senders.js';
import { createContact } from '../store.js';

const CREATE_CONTACTS =
  "CREATE TABLE contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT, emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', imessage_handles TEXT NOT NULL DEFAULT '[]', company TEXT, role TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', created_by_agent_id TEXT, last_updated_by_agent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))";
const all = () => mockDb.current!.prepare('SELECT * FROM contacts ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;
const s = (address: string, name: string): never => ({ address, name } as never);

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(CREATE_CONTACTS);
  mockDb.current = db;
});

describe('safe-sender mirror', () => {
  it('a shared label with a different address makes a separate contact and leaves the first alone', () => {
    createContact({ displayName: 'Pat Example', imessageHandles: ['+15550001'], company: 'Acme' }, null);
    const before = all()[0];
    syncSafeSendersToContacts('imessage', [s('+15550002', 'Pat Example')], null);
    const rows = all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before);
    expect(String(rows[1].imessage_handles)).toContain('+15550002');
  });

  it('an address already on file still augments that same person', () => {
    createContact({ displayName: 'Pat Example', emails: ['pat@x.test'] }, null);
    syncSafeSendersToContacts('imessage', [s('pat@x.test', 'Pat Example')], null);
    const rows = all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].imessage_handles)).toContain('pat@x.test');
  });

  it('never replaces an owner-set preferred name; fills it when blank', () => {
    createContact({ displayName: 'Pat Example', preferredName: 'Pat', emails: ['pat@x.test'] }, null);
    syncSafeSendersToContacts('gmail', [s('pat@x.test', 'Patty')], null);
    expect(all()[0].preferred_name).toBe('Pat');
    createContact({ displayName: 'Lee Example', emails: ['lee@x.test'] }, null);
    syncSafeSendersToContacts('gmail', [s('lee@x.test', 'Leigh')], null);
    expect(all()[1].preferred_name).toBe('Leigh');
  });

  it('a safe-sender-tagged contact still follows its label', () => {
    createContact({ displayName: 'Test', emails: ['t@x.test'], tags: ['safe-sender'] }, null);
    syncSafeSendersToContacts('gmail', [s('t@x.test', 'Ted')], null);
    expect(all()[0].display_name).toBe('Ted');
  });
});
