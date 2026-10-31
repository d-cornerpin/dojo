// A new contact must have a name; editing one must not be able to erase it either.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { updateContact, getContactById } from '../store.js';
import { contactsRouter } from '../../gateway/routes/contacts.js';

const CREATE_CONTACTS =
  "CREATE TABLE contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT, emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', imessage_handles TEXT NOT NULL DEFAULT '[]', company TEXT, role TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', created_by_agent_id TEXT, last_updated_by_agent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))";
const ID = '00000001-0000-4000-8000-000000000000';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(CREATE_CONTACTS);
  db.prepare('INSERT INTO contacts (id, display_name) VALUES (?, ?)').run(ID, 'Sample Person');
  mockDb.current = db;
});

const patch = (body: unknown) =>
  (contactsRouter as unknown as { request: (p: string, i: RequestInit) => Promise<Response> }).request(`/${ID}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

describe('updateContact', () => {
  it('ignores a spaces-only name in replace mode but saves the other fields', () => {
    updateContact(ID, { displayName: '   ', company: 'Acme' }, null, 'replace');
    const c = getContactById(ID)!;
    expect(c.displayName).toBe('Sample Person');
    expect(c.company).toBe('Acme');
  });
  it('ignores an empty name in append mode', () => {
    updateContact(ID, { displayName: '', company: 'Acme' }, null, 'append');
    const c = getContactById(ID)!;
    expect(c.displayName).toBe('Sample Person');
    expect(c.company).toBe('Acme');
  });
  it('saves a real new name trimmed', () => {
    updateContact(ID, { displayName: '  New Name ' }, null, 'replace');
    expect(getContactById(ID)!.displayName).toBe('New Name');
  });
});

describe('PATCH /:id', () => {
  it('refuses a blank display_name and changes nothing', async () => {
    const res = await patch({ display_name: '', company: 'Acme' });
    expect(res.status).toBe(400);
    const c = getContactById(ID)!;
    expect(c.displayName).toBe('Sample Person');
    expect(c.company).toBeNull();
  });
  it('accepts a patch without a name', async () => {
    const res = await patch({ company: 'Acme' });
    expect(res.status).toBe(200);
    expect(getContactById(ID)!.company).toBe('Acme');
  });
});
