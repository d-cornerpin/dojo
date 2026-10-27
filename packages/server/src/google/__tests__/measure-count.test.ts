// v3.5 DONE IS MEASURED, Task A2 — the Gmail counter: ids only, every page, the read tool's own account resolution.
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../client.js', () => ({ googleSilentFetch: vi.fn() }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: vi.fn() }));
vi.mock('../activity-log.js', () => ({ logGoogleActivity: vi.fn() }));
import { googleSilentFetch } from '../client.js';
import { resolveGoogleAccountForRead } from '../accounts.js';
import { logGoogleActivity } from '../activity-log.js';
import { countGmailSearch } from '../measure-count.js';

const fetchPage = googleSilentFetch as unknown as ReturnType<typeof vi.fn>;
const resolve = resolveGoogleAccountForRead as unknown as ReturnType<typeof vi.fn>;
const log = logGoogleActivity as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchPage.mockReset();
  resolve.mockReset();
  log.mockReset();
  resolve.mockImplementation((kind: string) => ({ account: { id: `row-${kind}-1` }, labelAccount: false }));
});

describe('countGmailSearch', () => {
  it('follows every page and counts ids only', async () => {
    fetchPage
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })), nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })) } });
    const r = await countGmailSearch({ query: 'in:inbox' }, 'agent-1', 'Agent');
    expect(r).toEqual({ ok: true, count: 512 });
    const urls = fetchPage.mock.calls.map((c) => c[1] as string);
    expect(urls[0]).toContain('maxResults=500');
    expect(urls[0]).toContain('fields=messages%2Fid%2CnextPageToken');
    expect(urls[1]).toContain('pageToken=p2');
  });
  it('reports zero on an empty list', async () => {
    fetchPage.mockResolvedValueOnce({ ok: true, data: {} });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A')).toEqual({ ok: true, count: 0 });
  });
  it('surfaces an API error instead of guessing', async () => {
    fetchPage.mockResolvedValueOnce({ ok: false, error: '503 backend' });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A')).toEqual({ ok: false, error: '503 backend' });
  });
  it('reads the mailbox the read tool would: the named account resolves to its row id, per kind', async () => {
    fetchPage.mockResolvedValue({ ok: true, data: {} });
    await countGmailSearch({ query: 'in:inbox', account: 'someone@example.com' }, 'a', 'A', 'user');
    expect(resolve).toHaveBeenCalledWith('user', 'someone@example.com');
    expect(fetchPage.mock.calls[0][4]).toBe('row-user-1');
    await countGmailSearch({ query: 'in:inbox' }, 'a', 'A');
    expect(resolve).toHaveBeenLastCalledWith('agent', undefined);
    expect(fetchPage.mock.calls[1][4]).toBe('row-agent-1');
  });
  it('a mailbox that cannot be resolved is an error, never a zero', async () => {
    resolve.mockReturnValueOnce({ error: 'No Google account is connected' });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A', 'user')).toEqual({ ok: false, error: 'No Google account is connected' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('one count is one activity row: three pages, success', async () => {
    fetchPage
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })), nextPageToken: 'p2' }, apiEndpoint: 'u1' })
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}` })), nextPageToken: 'p3' }, apiEndpoint: 'u2' })
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` })) }, apiEndpoint: 'u3' });
    const r = await countGmailSearch({ query: 'in:inbox' }, 'agent-1', 'Agent');
    expect(r).toEqual({ ok: true, count: 1012 });
    expect(log).toHaveBeenCalledTimes(1);
    const row = log.mock.calls[0][0];
    expect(row.action).toBe('measure_count');
    expect(row.actionType).toBe('read');
    expect(row.success).toBe(true);
    expect(JSON.parse(row.details)).toEqual({ query: 'in:inbox', pages: 3, count: 1012, account: 'row-agent-1' });
  });
  it('a failing page is one row, success false, and the failure surfaces', async () => {
    fetchPage
      .mockResolvedValueOnce({ ok: true, data: { messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })), nextPageToken: 'p2' }, apiEndpoint: 'u1' })
      .mockResolvedValueOnce({ ok: false, error: '503 backend', apiEndpoint: 'u2' });
    const r = await countGmailSearch({ query: 'in:inbox' }, 'a', 'A');
    expect(r).toEqual({ ok: false, error: '503 backend' });
    expect(log).toHaveBeenCalledTimes(1);
    const row = log.mock.calls[0][0];
    expect(row.success).toBe(false);
    expect(row.error).toBe('503 backend');
    expect(JSON.parse(row.details)).toEqual({ query: 'in:inbox', pages: 2, count: 500, account: 'row-agent-1' });
  });
  it('an unresolvable mailbox writes no row and reads nothing', async () => {
    resolve.mockReturnValueOnce({ error: 'No Google account is connected' });
    expect(await countGmailSearch({ query: 'in:inbox' }, 'a', 'A', 'user')).toEqual({ ok: false, error: 'No Google account is connected' });
    expect(log).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('a silent page read is still an agent-owned call: the stop reaches the agent id', async () => {
    fetchPage.mockResolvedValue({ ok: true, data: {}, apiEndpoint: 'u' });
    await countGmailSearch({ query: 'in:inbox' }, 'agent-1', 'Agent');
    expect(fetchPage.mock.calls[0][5]).toBe('agent-1');
  });
});
