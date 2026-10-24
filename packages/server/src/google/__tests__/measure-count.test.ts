// v3.5 DONE IS MEASURED, Task A2 — the Gmail counter: ids only, every page, the read tool's own account resolution.
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../client.js', () => ({ googleRead: vi.fn() }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: vi.fn() }));
import { googleRead } from '../client.js';
import { resolveGoogleAccountForRead } from '../accounts.js';
import { countGmailSearch } from '../measure-count.js';

const read = googleRead as unknown as ReturnType<typeof vi.fn>;
const resolve = resolveGoogleAccountForRead as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  read.mockReset();
  resolve.mockReset();
  resolve.mockImplementation((kind: string) => ({ account: { id: `row-${kind}-1` }, labelAccount: false }));
});

describe('countGmailSearch', () => {
  it('follows every page and counts ids only', async () => {
    read
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })), nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })) } });
    const r = await countGmailSearch({ query: 'in:inbox' }, 'agent-1', 'Agent');
    expect(r).toEqual({ ok: true, count: 512 });
    const urls = read.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('maxResults=500');
    expect(urls[0]).toContain('fields=messages%2Fid%2CnextPageToken');
    expect(urls[1]).toContain('pageToken=p2');
  });
  it('reports zero on an empty list', async () => {
    read.mockResolvedValueOnce({ ok: true, data: {} });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A')).toEqual({ ok: true, count: 0 });
  });
  it('surfaces an API error instead of guessing', async () => {
    read.mockResolvedValueOnce({ ok: false, error: '503 backend' });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A')).toEqual({ ok: false, error: '503 backend' });
  });
  it('reads the mailbox the read tool would: the named account resolves to its row id, per kind', async () => {
    read.mockResolvedValue({ ok: true, data: {} });
    await countGmailSearch({ query: 'in:inbox', account: 'someone@example.com' }, 'a', 'A', 'user');
    expect(resolve).toHaveBeenCalledWith('user', 'someone@example.com');
    expect(read.mock.calls[0][5]).toBe('row-user-1');
    await countGmailSearch({ query: 'in:inbox' }, 'a', 'A');
    expect(resolve).toHaveBeenLastCalledWith('agent', undefined);
    expect(read.mock.calls[1][5]).toBe('row-agent-1');
  });
  it('a mailbox that cannot be resolved is an error, never a zero', async () => {
    resolve.mockReturnValueOnce({ error: 'No Google account is connected' });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A', 'user')).toEqual({ ok: false, error: 'No Google account is connected' });
    expect(read).not.toHaveBeenCalled();
  });
});
