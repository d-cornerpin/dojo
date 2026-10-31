// HEADER NAMES AND THE "RE:" PREFIX ARE MATCHED WITHOUT REGARD TO CASE.
//
// THE DEFECT. The reply context matched the original Subject with
// `startsWith('Re:')` and the Message-ID header with `h.name === 'Message-ID'`.
// Header names are case-insensitive in mail and senders spell them
// `Message-Id` as often as `Message-ID`, and subjects arrive as `RE: Plan` or
// `re: Plan` — so a reply to `RE: Plan` was titled `Re: RE: Plan`, and a message
// whose id header was spelled `Message-Id` got an empty `msgIdHeader`, leaving
// the reply unlinked from the thread it answers. The same function already
// reads Reply-To as `h.name.toLowerCase() === 'reply-to'`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));

import { googleRead } from '../client.js';
import { gmailReplyContext } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });

const originalMessage = (headers: Array<{ name: string; value: string }>) => ({
  threadId: 'thr9',
  payload: { headers },
});

/** Mock the Gmail read of the original message and build its reply context. */
const ctxOf = async (headers: Array<{ name: string; value: string }>) => {
  vi.mocked(googleRead).mockResolvedValue(ok(originalMessage(headers)) as never);
  const res = await gmailReplyContext('m1', false, 'agent-1', 'A Worker', 'slot-1', 'gmail_reply_fetch', null);
  if (!res.ok) throw new Error(res.error);
  return res.ctx;
};

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
});

describe('gmail reply context header case', () => {
  const subjectOnly = (subject: string) => [
    { name: 'From', value: 'a@x.com' },
    { name: 'To', value: 'agent@example.com' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: '<msg1@x.com>' },
  ];

  it('a subject already prefixed RE: keeps its own prefix', async () => {
    expect((await ctxOf(subjectOnly('RE: Plan'))).replySubject).toBe('RE: Plan');
  });

  it('a subject already prefixed re: keeps its own prefix', async () => {
    expect((await ctxOf(subjectOnly('re: Plan'))).replySubject).toBe('re: Plan');
  });

  it('a subject with no prefix gets the Re: prefix', async () => {
    expect((await ctxOf(subjectOnly('Plan'))).replySubject).toBe('Re: Plan');
  });

  it('a Message-Id header spelled without the capital D still gives the id', async () => {
    const ctx = await ctxOf([
      { name: 'From', value: 'a@x.com' },
      { name: 'To', value: 'agent@example.com' },
      { name: 'Subject', value: 'Plan' },
      { name: 'Message-Id', value: '<msg1@x.com>' },
    ]);
    expect(ctx.msgIdHeader).toBe('<msg1@x.com>');
  });
});
