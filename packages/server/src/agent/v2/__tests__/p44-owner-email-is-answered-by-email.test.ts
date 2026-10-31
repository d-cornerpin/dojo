// P44 (lane t280): the owner's provider-confirmed email may be answered by email, like his text is answered
// by text. The watcher's `relation: 'owner'` stamp opens the door ONLY while the sender is still one of the
// owner's connected mailboxes (re-read from the account tables at resolve time, like the safe-sender recheck
// it replaces for him). A row without the stamp, an owner's-inbox row, or a disconnected account gets the
// dashboard notice exactly as before.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
import { runMigrations } from '../../../db/migrations.js';
import { resolveInbound } from '../inbound-channel.js';

const meta = (over: Record<string, unknown> = {}): string => JSON.stringify({
  channel: 'email', accountKind: 'agent', authorized: true, sender: 'owner@home.test', emailMessageId: 'm1', emailService: 'gmail', emailAccount: 'agent@x.com', ...over,
});
const resolve = (inboundMeta: string) => resolveInbound({ agentId: 'primary', content: 'x', channel: 'email', inboundMeta });

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.test', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('P44 — the owner\'s confirmed email can be answered by email', () => {
  it('a stamped owner email from a connected owner mailbox routes a reply to the thread', () => {
    const r = resolve(meta({ relation: 'owner', ownerWords: 'Yes.' }));
    expect(r.inboundChannel).toBe('email');
    expect(r.inboundContext?.emailMessageId).toBe('m1');
  });

  it('no stamp, no door: the same address without the watcher\'s owner relation is a dashboard notice', () => {
    expect(resolve(meta()).inboundChannel).toBe('dashboard');
  });

  it('a stamp whose mailbox was disconnected since is a dashboard notice', () => {
    mockDb.current!.prepare("UPDATE google_accounts SET connected = 0 WHERE id = 'g-user'").run();
    expect(resolve(meta({ relation: 'owner', ownerWords: 'Yes.' })).inboundChannel).toBe('dashboard');
  });

  it('the stamp never opens the door for a different sender address', () => {
    expect(resolve(meta({ relation: 'owner', sender: 'someone@else.test' })).inboundChannel).toBe('dashboard');
  });

  it('a row from the owner\'s own inbox is never answered, stamp or not', () => {
    expect(resolve(meta({ relation: 'owner', accountKind: 'user' })).inboundChannel).toBe('dashboard');
  });
});
