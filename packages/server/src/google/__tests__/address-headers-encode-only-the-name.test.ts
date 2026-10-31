// An accented display name made the whole To/Cc/Bcc line one encoded word, address and commas
// included, so Gmail answered "Invalid To header". Only the display name may be encoded:
// `=?utf-8?B?...?= <addr>`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(), getDbPath: () => ':memory:',
}));
import { runMigrations } from '../../db/migrations.js';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));

import { googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const send = (args: Record<string, unknown>) => executeGoogleWriteTool('gmail_send', { subject: 'Hi', body: 'Hello', ...args }, 'agent-1', 'A Worker');

const rawHeader = (name: string): string => {
  const body = vi.mocked(googleWrite).mock.calls[0]?.[2] as Record<string, unknown>;
  const raw = (body.raw ?? (body.message as Record<string, unknown> | undefined)?.raw) as string;
  const headBlock = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
  const m = headBlock.match(new RegExp(`^${name}: (.*)$`, 'm'));
  return m ? m[1] : '';
};
const words = (s: string) => [...s.matchAll(/=\?utf-8\?B\?([^?]*)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm2', threadId: 't1' }) as never);
});

describe('address headers encode only the display name', () => {
  it('keeps the address outside the encoded word', async () => {
    await send({ to: 'José García <jose@example.com>' });
    const to = rawHeader('To');
    expect(to.replace(/=\?utf-8\?B\?[^?]*\?=/g, '')).toContain('<jose@example.com>');
    expect(words(to)).toEqual(['José García']);
  });

  it('leaves ASCII entries alone and encodes just the accented quoted name', async () => {
    await send({ to: 'Ann Lee <ann@example.com>, "Zoë Q" <zoe@example.com>' });
    const to = rawHeader('To');
    expect(to.startsWith('Ann Lee <ann@example.com>, =?utf-8?B?')).toBe(true);
    expect(to.endsWith('?= <zoe@example.com>')).toBe(true);
    expect(words(to)).toEqual(['Zoë Q']);
  });

  it('does not touch an all-ASCII To line', async () => {
    await send({ to: 'Ann Lee <ann@example.com>,bob@example.com' });
    expect(rawHeader('To')).toBe('Ann Lee <ann@example.com>,bob@example.com');
  });

  it('still encodes a non-ASCII Subject as one word', async () => {
    await send({ to: 'ann@example.com', subject: 'Café' });
    const subject = rawHeader('Subject');
    expect(subject).toMatch(/^=\?utf-8\?B\?[^?]*\?=$/);
    expect(words(subject)).toEqual(['Café']);
  });
});
