// C3 (R4): the agent is told who a reply actually went to, and gmail_read shows Reply-To.

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
  resolveGoogleAccountForRead: vi.fn(() => ({ account: { id: 'agent', email: 'agent@example.com' }, labelAccount: false })),
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
import { executeGoogleReadTool } from '../tools-read.js';

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


describe('reply results name the real recipients', () => {
  it('gmail_reply says it went to the Reply-To address, with the Cc list', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([
      { name: 'Reply-To', value: 'Dana <dana@shop.example>' },
      { name: 'Cc', value: 'lee@example.com' },
    ]) as never);
    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toContain('To: Dana <dana@shop.example>');
    expect(out).toContain('Cc: lee@example.com');
    expect(out).not.toContain('noreply@shop.example');
  });

  it('a plain reply names its To and no Cc', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([]) as never);
    const out = await run({ message_id: 'm1' });
    expect(out).toContain('To: Shop <noreply@shop.example>');
    expect(out).not.toContain('Cc:');
  });

  it('a reply draft names the real recipients too', async () => {
    vi.mocked(googleRead).mockResolvedValue(msg([{ name: 'Reply-To', value: 'Dana <dana@shop.example>' }]) as never);
    vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'd1', message: { id: 'm2', threadId: 'thr9' } }) as never);
    const out = await executeGoogleWriteTool('gmail_draft', { reply_to_message_id: 'm1', body: 'hi' }, 'agent-1', 'A Worker');
    expect(out).toContain('addressed to Dana <dana@shop.example>');
  });

  it('gmail_read shows a Reply-To line when the message has one, and none when it has not', async () => {
    const full = (extra: Array<{ name: string; value: string }>) => ok({
      id: 'm1', snippet: 's',
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Shop <noreply@shop.example>' }, { name: 'To', value: 'agent@example.com' }, ...extra, { name: 'Subject', value: 'Your order' }, { name: 'Date', value: 'Mon, 1 Jan 2026 10:00:00 +0000' }], body: { data: Buffer.from('hello').toString('base64url') } },
    });
    vi.mocked(googleRead).mockResolvedValue(full([{ name: 'Reply-To', value: 'Dana <dana@shop.example>' }]) as never);
    expect(await executeGoogleReadTool('gmail_read', { message_id: 'm1' }, 'agent-1', 'A Worker')).toContain('Reply-To: Dana <dana@shop.example>');
    vi.mocked(googleRead).mockResolvedValue(full([]) as never);
    expect(await executeGoogleReadTool('gmail_read', { message_id: 'm1' }, 'agent-1', 'A Worker')).not.toContain('Reply-To:');
  });
});
