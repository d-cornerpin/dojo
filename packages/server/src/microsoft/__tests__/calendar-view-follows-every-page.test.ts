// Graph's calendarView answers 10 events per page and hands the rest over through
// @odata.nextLink. The agenda and the calendar search used to read only the first page.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForRead: vi.fn(() => ({ account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true }, labelAccount: false })),
}));

import { msGraphRead } from '../client.js';
import { executeMicrosoftReadTool, fetchAgendaItemsForAccountMs } from '../tools-read.js';

const NEXT = 'https://graph.microsoft.com/v1.0/next-page';
const ev = (n: number) => ({ id: `ev${n}`, subject: `Standup ${n}`, start: { dateTime: `2030-01-0${n}T09:00:00`, timeZone: 'UTC' }, end: { dateTime: `2030-01-0${n}T10:00:00`, timeZone: 'UTC' }, isAllDay: false });

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => (
    endpoint === NEXT
      ? { ok: true, data: { value: [ev(3)] }, error: null }
      : { ok: true, data: { value: [ev(1), ev(2)], '@odata.nextLink': NEXT }, error: null }
  )) as never);
});

describe('calendarView follows every page', () => {
  it('the agenda returns the events of every page and asks for a big page', async () => {
    const r = await fetchAgendaItemsForAccountMs('agent', { startISO: '2030-01-01T00:00:00Z', endISO: '2030-01-08T00:00:00Z', anchored: true }, 'a1', 'Agent One');
    expect(r.ok && r.items.map((i) => i.id)).toEqual(['ev1', 'ev2', 'ev3']);
    expect(String(vi.mocked(msGraphRead).mock.calls[0][0])).toContain('$top=100');
  });

  it('the search finds matches on every page', async () => {
    const out = await executeMicrosoftReadTool('calendar_search_ms', { query: 'Standup' }, 'a1', 'Agent One');
    expect(out).toContain('Found 3 event(s)');
    expect(out).toContain('[ID: ev3]');
    expect(String(vi.mocked(msGraphRead).mock.calls[0][0])).toContain('$top=100');
  });
});
