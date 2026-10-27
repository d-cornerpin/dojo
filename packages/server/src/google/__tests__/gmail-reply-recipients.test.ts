// ════════════════════════════════════════════════════════════════════════════════════════
// THE REPLY-ALL RECIPIENT PAIR: ORIGINAL FROM ON THE TO LINE, ORIGINAL TO + CC ON THE CC LINE.
//
// THE DEFECT. `gmailReplyContext` built a reply-all recipient list as
// `[from, to].filter(Boolean).join(', ')` — it (a) dropped everyone on the original
// Cc line, and (b) kept the replying mailbox's own address when it sat on the To line,
// so the agent emailed itself. The reply must address every original recipient minus
// the mailbox sending it — the original From on To, the original To + Cc on Cc — with
// duplicates collapsed case-insensitively by bare address while the original display
// form is kept. A plain reply stays just the original From, with no Cc line at all.
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
const runDraft = (args: Record<string, unknown>) => executeGoogleWriteTool('gmail_draft', args, 'agent-1', 'A Worker');

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
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm2', threadId: 'thr9' }) as never);
});

describe('gmail_reply reply-all recipients', () => {
  it('puts the original From on To and the original To + Cc on Cc, minus the own mailbox', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com, b@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('b@x.com, c@x.com');
  });

  it('drops Cc addresses already on To by bare address, case-insensitively, keeping the first form', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'b@x.com' },
      { name: 'Cc', value: 'a@x.com, B@X.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('b@x.com');
  });

  it('drops the own mailbox when it sits on the Cc line', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'b@x.com' },
      { name: 'Cc', value: 'AGENT@example.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('b@x.com');
  });

  it('replying to its own sent message puts To minus itself on To and Cc minus itself on Cc', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'Me <agent@example.com>' },
      { name: 'To', value: 'b@x.com, agent@example.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('b@x.com');
    expect(rawCc()).toBe('c@x.com');
  });

  it('keeps the original display names', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'Ann <a@x.com>' },
      { name: 'To', value: 'Bob <b@x.com>' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('Ann <a@x.com>');
    expect(rawCc()).toBe('Bob <b@x.com>');
  });

  it('a plain reply stays just the original From with no Cc line', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com, b@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1' });
    expect(out).toMatch(/^Reply sent/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('');
  });

  it('end to end: the raw gmail_reply message carries the To and Cc lines', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com, b@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await run({ message_id: 'm1', reply_all: true });
    expect(out).toMatch(/^Reply sent/);
    // The Cc header must be requested from Gmail's metadata, or it is never present.
    expect(String(vi.mocked(googleRead).mock.calls[0]?.[0])).toContain('metadataHeaders=Cc');
    const headBlock = Buffer.from(writtenBody().raw as string, 'base64url').toString('utf8').split('\r\n\r\n')[0];
    expect(headBlock).toMatch(/^To: a@x\.com$/m);
    expect(headBlock).toMatch(/^Cc: b@x\.com, c@x\.com$/m);
  });

  it('a reply-all draft uses the context Cc when no cc arg is passed', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com, b@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await runDraft({ reply_to_message_id: 'm1', reply_all: true, body: 'hi' });
    expect(out).toMatch(/^Draft saved/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('b@x.com, c@x.com');
  });

  it('a reply-all draft honors an explicit agent cc over the context Cc', async () => {
    vi.mocked(googleRead).mockResolvedValue(ok(originalMessage([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com, b@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-ID', value: '<msg1@x.com>' },
    ])) as never);

    const out = await runDraft({ reply_to_message_id: 'm1', reply_all: true, cc: 'z@x.com', body: 'hi' });
    expect(out).toMatch(/^Draft saved/);
    expect(rawTo()).toBe('a@x.com');
    expect(rawCc()).toBe('z@x.com');
  });
});
