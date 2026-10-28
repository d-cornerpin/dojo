// Searching with an apostrophe broke both `calendar_search_ms` and `onedrive_search`: the query
// was only URL-encoded, but `encodeURIComponent` leaves `'` as it is, so Graph received an OData
// string closed early by the apostrophe and answered a syntax error ("Error searching
// calendar: ..." / "Error searching OneDrive: ..."). Inside a single-quoted OData string the
// apostrophe is written twice before the text is URL-encoded, as elsewhere in this folder.

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

describe('single-quoted OData search strings — an apostrophe is written twice', () => {
  it('calendar_search_ms doubles the apostrophe and still encodes the space', async () => {
    await executeMicrosoftReadTool('calendar_search_ms', { query: "Bob's review" }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain("contains(subject,'Bob''s%20review')");
  });

  it('onedrive_search doubles the apostrophe inside search(q=...)', async () => {
    await executeMicrosoftReadTool('onedrive_search', { query: "O'Brien plan" }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain("root/search(q='O''Brien%20plan')");
  });

  it('a query without an apostrophe is unchanged', async () => {
    await executeMicrosoftReadTool('calendar_search_ms', { query: 'lunch' }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain("contains(subject,'lunch')");
    vi.mocked(msGraphRead).mockClear();
    await executeMicrosoftReadTool('onedrive_search', { query: 'budget' }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain("root/search(q='budget')");
  });

  it('two apostrophes in a row become four', async () => {
    await executeMicrosoftReadTool('calendar_search_ms', { query: "a''b" }, 'agent-1', 'Agent One');
    expect(firstUrl()).toContain("contains(subject,'a''''b')");
  });
});
