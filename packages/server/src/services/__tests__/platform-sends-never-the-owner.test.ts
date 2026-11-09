// P44 review C2: mail the platform itself sent from the owner's own connected mailbox (send-as) and that
// arrives in the agent's mailbox with a genuine DMARC pass is the agent's own mail, never the owner speaking.
// The record is written at send time (every send path), and the intake refuses owner status to a recorded id.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../../google/client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../../microsoft/client.js', () => ({ msGraphRead: vi.fn(), msGraphWrite: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { judgeOwnerEmail } from '../mail-owner-intake.js';
import { newPlatformSend, platformSendHeaderLines, graphSendHeaders, recordPlatformSend, isPlatformSent } from '../platform-sends.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  mockDb.current.prepare("INSERT INTO google_accounts (id, kind, position, email, connected) VALUES ('g-user', 'user', 0, 'owner@home.test', 1)").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const PASS = 'mx.google.com; dmarc=pass header.from=home.test';
const arrival = (extra: Array<{ name: string; value: string }>) => judgeOwnerEmail({
  provider: 'gmail', kind: 'agent', placement: 'to', from: 'owner@home.test', deliveryRef: 'test:x:1',
  headers: async () => [{ name: 'From', value: 'owner@home.test' }, { name: 'Authentication-Results', value: PASS }, ...extra],
  newBody: async () => 'close it',
  isMeeting: async () => false,
});

describe('P44 C2 — the platform\'s own sends are never the owner', () => {
  it('control: the owner\'s genuine email (an id nobody recorded) is the owner', async () => {
    expect(await arrival([{ name: 'Message-ID', value: '<genuine@mail.home.test>' }])).toEqual({ state: 'confirmed', words: 'close it' });
  });

  it('a Gmail send is stamped with a recorded Message-ID and send id before it goes out; it arrives and is not the owner', async () => {
    const lines = platformSendHeaderLines();   // what buildRfc2822Email writes into every raw message
    const headers = lines.map((l) => ({ name: l.split(': ')[0], value: l.slice(l.indexOf(': ') + 2) }));
    expect(headers.map((h) => h.name)).toEqual(['Message-ID', 'X-Platform-Send-Id']);
    expect(await arrival(headers)).toEqual({ state: 'none' });
  });

  it('either id alone is enough (a provider that rewrites one header still carries the other)', async () => {
    const { sendId, messageId } = newPlatformSend();
    expect(await arrival([{ name: 'X-Platform-Send-Id', value: sendId }])).toEqual({ state: 'none' });
    expect(await arrival([{ name: 'message-id', value: messageId.toUpperCase() }])).toEqual({ state: 'none' });
  });

  it('Gmail rewrites Message-ID on delivery: the rewritten Message-ID plus the recorded X-Platform-Send-Id is still not the owner', async () => {
    const { sendId } = newPlatformSend();
    expect(await arrival([{ name: 'Message-ID', value: '<CAF-rewritten-by-gmail@mail.example.test>' }, { name: 'X-Platform-Send-Id', value: sendId }])).toEqual({ state: 'none' });
  });

  it('an Outlook sendMail carries the recorded x- header; a reply or forward is recorded from its Sent Items copy', async () => {
    const [h] = graphSendHeaders();
    expect(isPlatformSent([{ name: h.name, value: h.value }])).toBe(true);
    recordPlatformSend('<AAMk-sent-copy@outlook.test>');
    expect(await arrival([{ name: 'Message-ID', value: '<aamk-sent-copy@outlook.test>' }])).toEqual({ state: 'none' });
  });
});
