// A message that sets Reply-To is answered at Reply-To, not at its From address.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Every send now records its send id before it goes out (P44), so the send needs a database to write to.
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

import { googleRead, googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const run = (args: Record<string, unknown>) => executeGoogleWriteTool('gmail_reply', args, 'agent-1', 'A Worker');

const originalMessage = (headers: Array<{ name: string; value: string }>) => ({
  threadId: 'thr9',
  payload: { headers },
});

const writtenBody = () => vi.mocked(googleWrite).mock.calls[0]?.[2] as Record<string, unknown>;
const rawOf = (): string => {
  const body = writtenBody();
  const raw = body.raw ?? (body.message as Record<string, unknown> | undefined)?.raw;
  return raw as string;
};
const rawHeader = (name: string): string => {
  const headBlock = Buffer.from(rawOf(), 'base64url').toString('utf8').split('\r\n\r\n')[0];
  const m = headBlock.match(new RegExp(`^${name}: (.*)$`, 'm'));
  return m ? m[1] : '';
};
const rawTo = () => rawHeader('To');
const rawCc = () => rawHeader('Cc');

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm2', threadId: 'thr9' }) as never);
});

const msg = (extra: Array<{ name: string; value: string }>) => ok(originalMessage([
  { name: 'From', value: 'Shop <noreply@shop.example>' },
  { name: 'To', value: 'agent@example.com' },
  ...extra,
  { name: 'Subject', value: 'Your order' },
  { name: 'Message-ID', value: '<msg1@shop.example>' },
]));

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations();
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm2', threadId: 'thr9' }) as never);
});

describe('gmail_reply honours Reply-To', () => {
  it('a plain reply goes to Reply-To', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([{ name: 'Reply-To', value: 'Dana <dana@shop.example>' }]) as never);
    expect(await run({ message_id: 'm1' })).toMatch(/^Reply sent/);
    expect(String(vi.mocked(googleRead).mock.calls[0]?.[0])).toContain('metadataHeaders=Reply-To');
    expect(rawTo()).toBe('Dana <dana@shop.example>');
  });

  it('reply-all goes to Reply-To with the original Cc, and never to the From address', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([
      { name: 'Reply-To', value: 'Dana <dana@shop.example>' },
      { name: 'Cc', value: 'lee@example.com' },
    ]) as never);
    expect(await run({ message_id: 'm1', reply_all: true })).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Dana <dana@shop.example>');
    expect(rawCc()).toBe('lee@example.com');
    expect(Buffer.from(rawOf(), 'base64url').toString('utf8')).not.toContain('noreply@shop.example');
  });

  it('with no Reply-To header the recipients are the old ones', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([{ name: 'Cc', value: 'lee@example.com' }]) as never);
    expect(await run({ message_id: 'm1' })).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Shop <noreply@shop.example>');
    vi.mocked(googleWrite).mockClear();
    expect(await run({ message_id: 'm1', reply_all: true })).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Shop <noreply@shop.example>');
    expect(rawCc()).toBe('lee@example.com');
  });
});
