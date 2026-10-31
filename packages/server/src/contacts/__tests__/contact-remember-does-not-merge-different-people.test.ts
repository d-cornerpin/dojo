// contact_remember must never file a second person under the first, nor overwrite
// the first person's name, company or role. Fake people only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { executeContactRemember } from '../tools.js';

const CREATE_CONTACTS =
  "CREATE TABLE contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, preferred_name TEXT, emails TEXT NOT NULL DEFAULT '[]', phones TEXT NOT NULL DEFAULT '[]', imessage_handles TEXT NOT NULL DEFAULT '[]', company TEXT, role TEXT, notes TEXT, tags TEXT NOT NULL DEFAULT '[]', created_by_agent_id TEXT, last_updated_by_agent_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))";

const all = () => (mockDb.current!.prepare('SELECT * FROM contacts').all() as Array<Record<string, unknown>>);

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(CREATE_CONTACTS);
  mockDb.current = db;
});

describe('contact_remember', () => {
  it('(a) two people sharing a name but not an address stay two contacts', () => {
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'], company: 'Acme', role: 'Chair' });
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['b@y.test'], company: 'Beta' });
    const rows = all();
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => String(r.emails).includes('a@x.test'))!;
    expect(first.company).toBe('Acme');
    expect(first.role).toBe('Chair');
    expect(String(first.emails)).not.toContain('b@y.test');
  });

  it('(b) the same address with a different company keeps the existing company', () => {
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'], company: 'Acme' });
    const out = executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'], company: 'Beta', notes: 'likes tea' });
    const rows = all();
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe('Acme');
    expect(String(rows[0].notes)).toContain('likes tea');
    expect(out).toContain('Acme');
  });

  it('(b2) an empty field is still filled in', () => {
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'] });
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'], company: 'Beta' });
    expect(all()[0].company).toBe('Beta');
  });

  it('(c) a note with no address still goes to the one person of that name', () => {
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'] });
    executeContactRemember('ag', { display_name: 'Pat Example', notes: 'prefers mornings' });
    const rows = all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].notes)).toContain('prefers mornings');
  });

  it('(d) a note with no address and two people of that name asks instead of choosing', () => {
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['a@x.test'] });
    executeContactRemember('ag', { display_name: 'Pat Example', emails: ['b@y.test'] });
    const out = executeContactRemember('ag', { display_name: 'Pat Example', notes: 'prefers mornings' });
    expect(out).toMatch(/more than one/i);
    for (const r of all()) expect(r.notes ?? '').not.toContain('prefers mornings');
  });
});
