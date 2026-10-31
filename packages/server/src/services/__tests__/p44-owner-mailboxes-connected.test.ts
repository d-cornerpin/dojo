// P44: the owner's email identity is derived from the account tables on every read. Only a
// CONNECTED account of kind 'user' counts; a disconnected one and any agent-kind account never do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
import { runMigrations } from '../../db/migrations.js';
import { ownerMailboxes } from '../owner-mailboxes.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('P44 — the owner\'s mailboxes come from connected user accounts only', () => {
  it('a connected user account counts; a disconnected one, and every agent account, do not', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'Owner@Home.test', 1)").run();
    db.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-agent', 'agent', 0, 'agent@home.test', 1)").run();
    db.prepare("INSERT INTO microsoft_accounts (id, kind, position, email, connected) VALUES ('m-user', 'user', 0, 'old@work.test', 0)").run();
    expect(ownerMailboxes().map((m) => m.address)).toEqual(['owner@home.test']);
  });

  it('disconnecting removes the address on the next read (nothing is stored twice)', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.test', 1)").run();
    expect(ownerMailboxes()).toHaveLength(1);
    db.prepare("UPDATE google_accounts SET connected = 0 WHERE id = 'g-user'").run();
    expect(ownerMailboxes()).toEqual([]);
  });
});
