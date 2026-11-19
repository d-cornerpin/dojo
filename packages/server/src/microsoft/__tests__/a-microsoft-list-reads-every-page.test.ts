// A Microsoft list with no size of its own (calendars, Teams, channels, task lists, notebooks, sections)
// is read to its end, so a calendar on Microsoft's second page is never reported as missing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForRead: vi.fn(() => ({ account: { id: 'acct-1', kind: 'agent', email: 'agent@example.com', connected: true }, labelAccount: false })),
}));

import { msGraphRead } from '../client.js';
import { executeMicrosoftReadTool } from '../tools-read.js';

const NEXT = 'https://graph.microsoft.com/v1.0/next-page';
const item = (n: number) => ({ id: `id-${n}`, name: `Calendar ${n}`, displayName: `Item ${n}` });

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => (
    endpoint === NEXT
      ? { ok: true, data: { value: [item(3)] }, error: undefined, apiEndpoint: endpoint }
      : { ok: true, data: { value: [item(1), item(2)], '@odata.nextLink': NEXT }, error: undefined, apiEndpoint: endpoint }
  )) as never);
});

describe('a Microsoft list reads every page', () => {
  it.each([
    ['calendar_list_ms', {}, 'Calendar 3'],
    ['teams_list_teams', {}, 'Item 3'],
    ['teams_list_channels', { team_id: 't1' }, 'Item 3'],
    ['tasks_list_lists', {}, 'Item 3'],
    ['onenote_list_notebooks', {}, 'Item 3'],
    ['onenote_list_sections', { notebook_id: 'n1' }, 'Item 3'],
  ])('%s shows the item on the second page', async (name, args, last) => {
    const out = await executeMicrosoftReadTool(name, args, 'agent-1', 'Agent One');
    expect(out).toContain(last);
    expect(out).not.toMatch(/^Error/);
  });

  it('a failed page is an error, not a short list', async () => {
    vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => (
      endpoint === NEXT
        ? { ok: false, data: null, error: 'HTTP 503', apiEndpoint: endpoint }
        : { ok: true, data: { value: [item(1)], '@odata.nextLink': NEXT }, error: undefined, apiEndpoint: endpoint }
    )) as never);
    const out = await executeMicrosoftReadTool('calendar_list_ms', {}, 'agent-1', 'Agent One');
    expect(out).toBe('Error listing calendars: HTTP 503');
  });
});
