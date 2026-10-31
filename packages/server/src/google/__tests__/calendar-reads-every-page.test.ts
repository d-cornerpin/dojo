// The Google calendar agenda and calendar search follow nextPageToken, so a busy window loses no events.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn();
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({ otherMailboxesCountSection: async () => '' }));

const { executeGoogleReadTool, fetchAgendaItemsForAccount } = await import('../tools-read.js');

const ev = (id: string) => ({
  id, summary: `event ${id}`,
  start: { dateTime: '2099-05-20T10:00:00Z' }, end: { dateTime: '2099-05-20T11:00:00Z' },
});
const page = (ids: string[], nextPageToken?: string) => ({ ok: true, data: { items: ids.map(ev), ...(nextPageToken ? { nextPageToken } : {}) } });
const window = { startISO: '2099-05-01T00:00:00Z', endISO: '2099-06-01T00:00:00Z', anchored: false };
const agenda = () => fetchAgendaItemsForAccount('acct-1', window, 'UTC', 'agent-1', 'A Worker');
const search = () => executeGoogleReadTool('calendar_search', { query: 'event' }, 'agent-1', 'A Worker');

beforeEach(() => googleRead.mockReset());

describe('calendar reads follow every page', () => {
  it('agenda: both pages are returned and the second call carries pageToken', async () => {
    googleRead.mockResolvedValueOnce(page(['a', 'b'], 'p2')).mockResolvedValueOnce(page(['c']));
    const r = await agenda();
    expect(r.ok && r.items.length).toBe(3);
    expect(String(googleRead.mock.calls[1][0])).toContain('pageToken=p2');
    expect(String(googleRead.mock.calls[0][0])).not.toContain('pageToken');
  });

  it('search: both pages are counted', async () => {
    googleRead.mockResolvedValueOnce(page(['a', 'b'], 'p2')).mockResolvedValueOnce(page(['c']));
    expect(await search()).toContain('Found 3 event(s)');
    expect(String(googleRead.mock.calls[1][0])).toContain('pageToken=p2');
  });

  it('a failing second page returns the error from both reads', async () => {
    googleRead.mockResolvedValueOnce(page(['a'], 'p2')).mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect(await agenda()).toEqual({ ok: false, error: 'boom' });
    googleRead.mockReset();
    googleRead.mockResolvedValueOnce(page(['a'], 'p2')).mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect(await search()).toMatch(/^Error searching calendar:/);
  });

  it('a repeated token ends the loop', async () => {
    googleRead.mockResolvedValue(page(['a'], 'same'));
    const r = await agenda();
    expect(r.ok).toBe(true);
    expect(googleRead).toHaveBeenCalledTimes(2);
  });
});
