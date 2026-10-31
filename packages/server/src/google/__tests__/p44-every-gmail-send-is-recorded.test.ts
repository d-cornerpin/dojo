// P44 review C2: every Gmail send path (send, reply, forward) writes a Message-ID and a send id into the raw
// message and records both BEFORE the provider call, so mail the platform sends from the owner's mailbox is
// recognisable when it arrives. The record lives in the config table (`services/platform-sends.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({ account: { id: 'user', kind: 'user', position: 1, email: 'owner@home.test', enabled: true, connected: true, accessToken: null, refreshToken: null, tokenExpiresAt: null, grantedScopes: null, enabledServices: null, watchEmail: false, sendEmail: true, lastVerifiedAt: null } })),
}));
import { runMigrations } from '../../db/migrations.js';
import { googleRead, googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';
import { isPlatformSent } from '../../services/platform-sends.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(googleWrite).mockReset(); vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'sent1', threadId: 't1' }) as never);
  vi.mocked(googleRead).mockResolvedValue(ok({ threadId: 't1', payload: { headers: [{ name: 'From', value: 'x@y.test' }, { name: 'Subject', value: 'hi' }, { name: 'Message-ID', value: '<orig@y.test>' }] } }) as never);
});

const sentHeaders = (): Array<{ name: string; value: string }> => {
  const raw = (vi.mocked(googleWrite).mock.calls[0]?.[2] as { raw: string }).raw;
  const head = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
  return head.split('\r\n').map((l) => ({ name: l.split(': ')[0], value: l.slice(l.indexOf(': ') + 2) }));
};

describe('P44 C2 — every Gmail send is recorded before it goes out', () => {
  for (const [tool, args] of [
    ['user_gmail_send', { to: 'agent@x.test', subject: 'hi', body: 'close it' }],
    ['user_gmail_reply', { message_id: 'orig1', body: 'close it' }],
    ['user_gmail_forward', { message_id: 'orig1', to: 'agent@x.test', body: 'close it' }],
  ] as const) {
    it(`${tool}: the raw message carries a Message-ID and send id the platform recorded`, async () => {
      await executeGoogleWriteTool(tool, args as Record<string, unknown>, 'a1', 'A Worker');
      const h = sentHeaders();
      expect(h.map((x) => x.name)).toEqual(expect.arrayContaining(['Message-ID', 'X-Platform-Send-Id']));
      expect(isPlatformSent(h)).toBe(true);
    });
  }
});
