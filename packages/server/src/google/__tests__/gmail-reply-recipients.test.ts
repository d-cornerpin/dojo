// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPLY-ALL RECIPIENT SET IS FROM + TO + CC, MINUS THE REPLYING MAILBOX ITSELF.
//
// THE DEFECT. `gmailReplyContext` built a reply-all recipient list as
// `[from, to].filter(Boolean).join(', ')` — it (a) dropped everyone on the original
// Cc line, and (b) kept the replying mailbox's own address when it sat on the To line,
// so the agent emailed itself. The reply must address every original recipient minus
// the mailbox sending it, with duplicates collapsed case-insensitively by bare address
// while the original display form is kept. Plain reply stays just the original From.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const rawTo = (): string => {
  const raw = writtenBody().raw as string;
  const headBlock = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
  const m = headBlock.match(/^To: (.*)$/m);
  return m ? m[1] : '';
};

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm2', threadId: 'thr9' }) as never);
});

describe('gmail_reply reply-all recipients', () => {
  it('keeps Cc, drops the own mailbox from To and Cc, and dedupes case-insensitively', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'Agent <agent@example.com>, Bob <bob@example.com>, Carol <carol@example.com>' },
      { name: 'Cc', value: 'agent@example.com, DAVE <dave@example.com>, Bob <bob@example.com>' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@example.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Alice <alice@example.com>, Bob <bob@example.com>, Carol <carol@example.com>, DAVE <dave@example.com>');
    // The Cc header must be requested from Gmail's metadata, or it is never present.
    expect(String(vi.mocked(googleRead).mock.calls[0]?.[0])).toContain('metadataHeaders=Cc');
  });

  it('a plain reply stays just the original From', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'Agent <agent@example.com>, Bob <bob@example.com>' },
      { name: 'Cc', value: 'Carol <carol@example.com>' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@example.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1' });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Alice <alice@example.com>');
  });

  it('deduplicates by bare address case-insensitively, keeping the first display form', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'Alice <alice@example.com>' },
      { name: 'To', value: 'alice@example.com, BOB <bob@example.com>' },
      { name: 'Cc', value: 'Bob <bob@example.com>, ALICE <alice@example.com>' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@example.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Alice <alice@example.com>, BOB <bob@example.com>');
  });
});
