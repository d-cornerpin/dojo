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
    const out = await run({ message_ids: all, add_labels: ['X'], remove_labels: ['INBOX'] });
    expect(googleWrite).toHaveBeenCalledTimes(2);
    expect(url(0)).toMatch(/\/messages\/batchModify$/);
    expect(url(1)).toMatch(/\/messages\/batchModify$/);
    expect(body(0)).toEqual({ ids: all.slice(0, 1000), addLabelIds: ['X'], removeLabelIds: ['INBOX'] });
    expect(body(1)).toEqual({ ids: all.slice(1000), addLabelIds: ['X'], removeLabelIds: ['INBOX'] });
    expect(out).toMatch(/^Labels updated on 1250 messages/);
    for (const id of ['m1', 'm1000', 'm1250']) expect(out).toContain(id);
    expect(googleRead).not.toHaveBeenCalled(); // no per-message thread lookup
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
    const out = await run({ message_ids: ['m1'], add_labels: ['Junk'] }, 'user_gmail_label');
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
