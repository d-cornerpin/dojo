// `outlook_inbox` with `unread_only=true` sent `$filter=isRead eq false` together with
// `$orderby=receivedDateTime desc`. Graph requires every `$orderby` property to also appear in
// `$filter`, first and in the same order, and answered HTTP 400 InefficientFilter — so the unread
// inbox failed on a real mailbox. The filter now leads with the sort property (`receivedDateTime ge`
// a far-past date, i.e. "any date") and then tests `isRead eq false`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(async () => ({ ok: true, data: { value: [] }, error: null })),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForRead: vi.fn(() => ({ account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true }, labelAccount: false })),
}));

import { msGraphRead } from '../client.js';
import { executeMicrosoftReadTool } from '../tools-read.js';

beforeEach(() => {
  vi.mocked(msGraphRead).mockClear();
});

/** The URL of the first msGraphRead call. */
const firstUrl = () => String(vi.mocked(msGraphRead).mock.calls[0][0]);
/** The raw text of the URL's `$filter=` parameter, or null when absent. */
const filterText = () => firstUrl().match(/\$filter=([^&]*)/)?.[1] ?? null;

describe('outlook_inbox — the unread filter carries the sort property Graph demands', () => {
  it('unread_only=true: the filter leads with receivedDateTime and still tests isRead, next to the sort', async () => {
    await executeMicrosoftReadTool('outlook_inbox', { unread_only: true }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain('$orderby=receivedDateTime desc');
    const f = filterText();
    expect(f).not.toBeNull();
    expect(f!.startsWith('receivedDateTime ge')).toBe(true);
    expect(f!.endsWith('isRead eq false')).toBe(true);
  });

  it('without unread_only there is no $filter at all', async () => {
    await executeMicrosoftReadTool('outlook_inbox', {}, 'agent-1', 'Agent One');
    expect(filterText()).toBeNull();
  });
});
