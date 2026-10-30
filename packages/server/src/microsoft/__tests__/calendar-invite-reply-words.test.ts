// The invite-reply confirmation tacked "ed" onto the raw response word, so the agent told the
// owner "Meeting invite declineed" or "Meeting invite tentativeed". Only "accept" grew a real
// past tense. The confirmation now uses a past-tense word per response.

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
import { executeMicrosoftWriteTool } from '../tools-write.js';

beforeEach(() => {
  vi.mocked(msGraphWrite).mockClear();
});

describe('calendar_respond_invite_ms — the confirmation says the word in past tense', () => {
  it('accept confirms as accepted', async () => {
    const out = await executeMicrosoftWriteTool('calendar_respond_invite_ms', { event_id: 'ev1', response: 'accept' }, 'agent-1', 'Agent One');
    expect(out).toBe('Meeting invite accepted');
  });

  it('decline confirms as declined, not declineed', async () => {
    const out = await executeMicrosoftWriteTool('calendar_respond_invite_ms', { event_id: 'ev1', response: 'decline' }, 'agent-1', 'Agent One');
    expect(out).toBe('Meeting invite declined');
  });

  it('tentative confirms as tentatively accepted, not tentativeed', async () => {
    const out = await executeMicrosoftWriteTool('calendar_respond_invite_ms', { event_id: 'ev1', response: 'tentative' }, 'agent-1', 'Agent One');
    expect(out).toBe('Meeting invite tentatively accepted');
  });

  it('a comment is still echoed after the word', async () => {
    const out = await executeMicrosoftWriteTool('calendar_respond_invite_ms', { event_id: 'ev1', response: 'decline', comment: 'Out of office' }, 'agent-1', 'Agent One');
    expect(out).toBe('Meeting invite declined with comment: "Out of office"');
  });

  it('an unknown response is refused and sends nothing', async () => {
    const out = await executeMicrosoftWriteTool('calendar_respond_invite_ms', { event_id: 'ev1', response: 'maybe' }, 'agent-1', 'Agent One');
    expect(out).toBe('Error: response must be "accept", "decline", or "tentative"');
    expect(msGraphWrite).not.toHaveBeenCalled();
  });
});
