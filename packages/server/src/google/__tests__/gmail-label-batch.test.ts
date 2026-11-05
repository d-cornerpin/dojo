// v3.5 B3 — gmail_label takes many ids per call. Messages go through Gmail's batchModify in
// chunks of 1,000 (Gmail's limit); conversations go one threads.modify each (Gmail has no
// thread batch). A failed chunk names the ids that were NOT changed.
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
import { remedyNote } from '../../tools/error-remedies.js';

const ok = (data: unknown = {}) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const run = (args: Record<string, unknown>, tool = 'gmail_label') =>
  executeGoogleWriteTool(tool, args, 'agent-1', 'A Worker');
const ids = (n: number, p = 'm') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const url = (i: number): string => String(vi.mocked(googleWrite).mock.calls[i]?.[1]);
const body = (i: number): Record<string, unknown> => vi.mocked(googleWrite).mock.calls[i]?.[2] as Record<string, unknown>;

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok() as never);
});

describe('gmail_label message_ids — batchModify in chunks of 1,000', () => {
  it('1,250 ids become two batchModify POSTs (1,000 + 250) with the right bodies', async () => {
    const all = ids(1250);
    // A label change that is NOT an archive labels the messages named (W18 widens only archives).
    const out = await run({ message_ids: all, add_labels: ['X'], remove_labels: ['UNREAD'] });
    expect(googleWrite).toHaveBeenCalledTimes(2);
    expect(url(0)).toMatch(/\/messages\/batchModify$/);
    expect(url(1)).toMatch(/\/messages\/batchModify$/);
    expect(body(0)).toEqual({ ids: all.slice(0, 1000), addLabelIds: ['X'], removeLabelIds: ['UNREAD'] });
    expect(body(1)).toEqual({ ids: all.slice(1000), addLabelIds: ['X'], removeLabelIds: ['UNREAD'] });
    expect(out).toMatch(/^Labels updated on 1250 messages/);
    for (const id of ['m1', 'm1000', 'm1250']) expect(out).toContain(id);
    expect(vi.mocked(googleRead).mock.calls.every((c) => String(c[0]).endsWith('/labels'))).toBe(true); // no per-message thread lookup; only the label list may be read
  });

  it('the singular message_id joins the list; a repeated id is sent once', async () => {
    await run({ message_id: 'a', message_ids: ['b', 'a'], add_labels: ['X'] });
    expect(googleWrite).toHaveBeenCalledTimes(1);
    expect(body(0).ids).toEqual(['b', 'a']);
  });

  it('a mixed call (message_ids + thread_ids) does both', async () => {
    const out = await run({ message_ids: ['m1', 'm2'], thread_ids: ['t1', 't2'], add_labels: ['X'] });
    expect(googleWrite).toHaveBeenCalledTimes(3);
    expect(url(0)).toMatch(/\/messages\/batchModify$/);
    expect(url(1)).toMatch(/\/threads\/t1\/modify$/);
    expect(url(2)).toMatch(/\/threads\/t2\/modify$/);
    expect(out).toMatch(/2 messages/);
    expect(out).toMatch(/2 conversations/);
    expect(out).not.toMatch(/^Error/);
  });

  it('a failed chunk is an Error that names the ids NOT changed, and the other chunk still ran', async () => {
    vi.mocked(googleWrite)
      .mockResolvedValueOnce(ok() as never)
      .mockResolvedValueOnce({ ok: false, data: null, error: 'Backend Error', apiEndpoint: 'x' } as never);
    const out = await run({ message_ids: ids(1250), add_labels: ['X'] });
    expect(googleWrite).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/^Error/);
    const notChanged = out.slice(out.search(/NOT changed/i));
    expect(notChanged).toContain('m1001');
    expect(notChanged).toContain('m1250');
    expect(notChanged).not.toContain('m1000,');
    expect(out).toContain('Backend Error');
  });

  it('the invalid-label remedy is kept on the batch path, with the user_ prefix when called as user_', async () => {
    vi.mocked(googleWrite).mockResolvedValue({ ok: false, data: null, error: 'Invalid label: Junk', apiEndpoint: 'x' } as never);
    const failed = await run({ message_ids: ['m1'], add_labels: ['Junk'] }, 'user_gmail_label');
    // K37: the remedy is appended by the engine from tools/error-remedies.ts, not inline.
    const out = failed + remedyNote('user_gmail_label', failed);
    expect(out).toMatch(/user_gmail_list_labels/);
    expect(out).toMatch(/NOT changed/i);
  });
});

describe('gmail_label thread_ids / thread_id', () => {
  it('thread_id with add_labels is exactly one threads.modify', async () => {
    const out = await run({ thread_id: 't9', add_labels: ['X'] });
    expect(googleWrite).toHaveBeenCalledTimes(1);
    expect(url(0)).toMatch(/\/threads\/t9\/modify$/);
    expect(body(0)).toEqual({ addLabelIds: ['X'], removeLabelIds: [] });
    expect(out).toMatch(/WHOLE conversation t9/);
  });

  it('thread_ids is one threads.modify each, in order', async () => {
    await run({ thread_ids: ['t1', 't2', 't3'], remove_labels: ['INBOX'] });
    expect(vi.mocked(googleWrite).mock.calls.map((c) => String(c[1]).match(/threads\/(\w+)\//)?.[1])).toEqual(['t1', 't2', 't3']);
  });

  it('a failed thread names the conversations NOT changed', async () => {
    vi.mocked(googleWrite)
      .mockResolvedValueOnce(ok() as never)
      .mockResolvedValueOnce({ ok: false, data: null, error: 'Not Found', apiEndpoint: 'x' } as never)
      .mockResolvedValueOnce(ok() as never);
    const out = await run({ thread_ids: ['t1', 't2', 't3'], add_labels: ['X'] });
    expect(out).toMatch(/^Error/);
    expect(out.slice(out.search(/NOT changed/i))).toContain('t2');
    expect(googleWrite).toHaveBeenCalledTimes(3);
  });
});

describe('gmail_label — the existing single-target behaviour is unchanged', () => {
  it('message_id + thread_id together still errors', async () => {
    const out = await run({ message_id: 'm', thread_id: 't', add_labels: ['X'] });
    expect(out).toMatch(/^Error/);
    expect(googleWrite).not.toHaveBeenCalled();
  });
  it('no target at all errors', async () => {
    const out = await run({ add_labels: ['X'] });
    expect(out).toMatch(/^Error/);
    expect(out).toContain('message_ids');
    expect(googleWrite).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════
// v3.5 field fix 3, audit W18 (owner card 2026-10-17: "Whole conversation"): a BATCH archive takes
// the whole conversation too. Gmail's inbox is per conversation, so removing INBOX from the named
// messages left their conversations in the inbox whenever another message there still carried it,
// and the junk "came back". The single archive already widened (gmail-archive.ts); the batch did not.
// ════════════════════════════════════════
describe('W18: a batch archive takes each message\'s whole conversation', () => {
  const threadOf: Record<string, string> = { m1: 't1', m2: 't1', m3: 't2' };
  beforeEach(() => {
    vi.mocked(googleRead).mockImplementation(async (u: string) => {
      const m = /\/messages\/([^/?]+)\?format=minimal/.exec(String(u));
      if (m) return (threadOf[m[1]] ? ok({ threadId: threadOf[m[1]] }) : { ok: false, data: null, error: 'Not Found', apiEndpoint: 'x' }) as never;
      return ok({ labels: [] }) as never;
    });
  });

  it('message_ids + INBOX removal: each conversation is archived once, by threads.modify', async () => {
    const out = await run({ message_ids: ['m1', 'm2', 'm3'], remove_labels: ['INBOX'] });
    const urls = vi.mocked(googleWrite).mock.calls.map((c) => String(c[1]));
    expect(urls.filter((u) => /\/messages\/batchModify$/.test(u))).toEqual([]);
    expect(urls.filter((u) => /\/threads\/t1\/modify$/.test(u))).toHaveLength(1);
    expect(urls.filter((u) => /\/threads\/t2\/modify$/.test(u))).toHaveLength(1);
    expect(out).toMatch(/^Labels updated on 2 conversations \(thread ids t1, t2\)/);
    expect(out).toContain('the WHOLE conversation of each message named');
  });

  it('a message whose conversation cannot be found is NOT silently archived on its own: it is named as not changed', async () => {
    const out = await run({ message_ids: ['m1', 'mX'], remove_labels: ['INBOX'] });
    expect(out).toMatch(/^Error/);
    expect(out).toContain('It was NOT changed on 1 message (ids mX)');
    expect(out).toContain('The change WAS applied to 1 conversation (thread ids t1)');
  });

  it('this_message_only=true keeps the old per-message batch', async () => {
    await run({ message_ids: ['m1', 'm2'], remove_labels: ['INBOX'], this_message_only: true });
    const urls = vi.mocked(googleWrite).mock.calls.map((c) => String(c[1]));
    expect(urls).toEqual([expect.stringMatching(/\/messages\/batchModify$/)]);
  });
});
