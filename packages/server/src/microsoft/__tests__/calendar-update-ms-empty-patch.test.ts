// B11 — an empty Microsoft calendar patch is refused, and the Outlook categories tool can clear.
//
// `calendar_update_ms` PATCHed `{}` and answered "updated". `outlook_categories_set` documents
// "pass an empty array to clear all categories" and yet the one validation boundary refused the
// empty array before the handler (which already knows how to clear) ever ran.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  msGraphWrite: vi.fn(async () => ({ ok: true, data: { id: 'x' }, error: null })),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForTool: vi.fn(() => ({
    account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true },
  })),
}));

import { msGraphWrite } from '../client.js';
import { executeMicrosoftWriteTool, microsoftWriteToolDefinitions } from '../tools-write.js';
import { validateToolArgs } from '../../agent/tools/validate-args.js';

beforeEach(() => {
  vi.mocked(msGraphWrite).mockClear();
});

describe('calendar_update_ms — nothing to change', () => {
  it('only event_id: refuses with the nothing-to-change error and sends no PATCH', async () => {
    const out = await executeMicrosoftWriteTool('calendar_update_ms', { event_id: 'ev1' }, 'agent-1', 'Agent One');
    expect(out).toMatch(/^Error: nothing to change/);
    expect(out).toContain('title');
    expect(msGraphWrite).not.toHaveBeenCalled();
  });

  it('one real field still patches', async () => {
    const out = await executeMicrosoftWriteTool('calendar_update_ms', { event_id: 'ev1', title: 'New name' }, 'agent-1', 'Agent One');
    expect(out).toBe('Calendar event ev1 updated');
    expect(msGraphWrite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(msGraphWrite).mock.calls[0][2]).toEqual({ subject: 'New name' });
  });
});

describe('outlook_categories_set — an empty array clears, as the description says', () => {
  const def = microsoftWriteToolDefinitions.find((d) => d.name === 'outlook_categories_set');

  it('the validation boundary lets [] through', () => {
    expect(validateToolArgs(def, { message_id: 'm1', categories: [] })).toBeNull();
  });

  it('the boundary still requires the field to be present', () => {
    expect(validateToolArgs(def, { message_id: 'm1' })).toBe('Error: `categories` is required.');
  });

  it('[] PATCHes categories: [] and says it cleared', async () => {
    const out = await executeMicrosoftWriteTool('outlook_categories_set', { message_id: 'm1', categories: [] }, 'agent-1', 'Agent One');
    expect(out).toContain('All categories cleared');
    expect(vi.mocked(msGraphWrite).mock.calls[0][2]).toEqual({ categories: [] });
  });
});
