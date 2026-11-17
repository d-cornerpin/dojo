// P44 replay guard (t280b): the Message-ID-once guard keys on the provider's own delivery (provider + account + provider
// message id) as well as the Message-ID. The SAME delivery looked at again (a poll that threw part-way and re-reads the
// message) is the same delivery and gets the same verdict; a DIFFERENT delivery carrying an already-used Message-ID is a
// replay and is not the owner. A guard that cannot be written fails closed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../owner-mailboxes.js', () => ({ ownerMailboxes: () => [{ address: 'owner@home.test', provider: 'google', accountId: 'g1' }] }));
vi.mock('../../google/client.js', () => ({ googleRead: vi.fn() }));
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: vi.fn() }));
import { runMigrations } from '../../db/migrations.js';
import { judgeOwnerEmail } from '../mail-owner-intake.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { try { mockDb.current?.close(); } catch { /* already closed */ } mockDb.current = null; });

const HEADERS = [{ name: 'From', value: 'owner@home.test' }, { name: 'Message-ID', value: '<m1@home.test>' }, { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass (p=NONE) header.from=home.test' }];
const judge = (deliveryRef: string, headers = HEADERS) => judgeOwnerEmail({
  provider: 'gmail', kind: 'agent', placement: 'to', from: 'owner@home.test', deliveryRef,
  headers: async () => headers, newBody: async () => 'close it', isMeeting: async () => false,
});
const CONFIRMED = { state: 'confirmed', words: 'close it' };

describe('P44 replay guard — the same delivery is not a replay', () => {
  it('a. the same provider delivery judged twice (or ten times) is confirmed every time, a re-read marked as one', async () => {
    expect(await judge('gmail:g1:abc')).toEqual(CONFIRMED);
    expect(await judge('gmail:g1:abc')).toEqual({ ...CONFIRMED, reread: true });
    expect(await judge('gmail:g1:abc')).toEqual({ ...CONFIRMED, reread: true });
  });

  it('b. a different delivery carrying the same Message-ID is a replay: not the owner', async () => {
    expect(await judge('gmail:g1:abc')).toEqual(CONFIRMED);
    expect(await judge('gmail:g1:def')).toEqual({ state: 'unconfirmed', reason: 'seen_before' });
    expect(await judge('gmail:g1:abc'), 'the original delivery still holds its verdict').toEqual({ ...CONFIRMED, reread: true });
  });

  it('the same provider item id on another account is another delivery', async () => {
    expect(await judge('gmail:g1:abc')).toEqual(CONFIRMED);
    expect(await judge('gmail:g2:abc')).toEqual({ state: 'unconfirmed', reason: 'seen_before' });
  });

  it('c. no Message-ID never counts', async () => {
    expect(await judge('gmail:g1:abc', HEADERS.filter((h) => h.name !== 'Message-ID'))).toEqual({ state: 'unconfirmed', reason: 'no_message_id' });
  });

  it('fail closed: when the record cannot be written, the email is not the owner', async () => {
    mockDb.current!.exec('DROP TABLE config');
    expect(await judge('gmail:g1:abc')).toEqual({ state: 'unconfirmed', reason: 'check_failed' });
  });
});
