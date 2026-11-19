// "Add lunch with a friend and invite them" makes Google email the guests an invitation, from the account
// the event is on. On an account whose "The agent may send as me" switch is off, an event with guests is
// refused with a plain reason, and an event with no guests is created as before.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const account = { sendEmail: true };
vi.mock('../client.js', () => ({
  googleRead: vi.fn(),
  googleWrite: vi.fn(async () => ({ ok: true, data: { id: 'ev1', htmlLink: 'https://example.test/ev1' }, error: null, apiEndpoint: 'x' })),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'acct-1', kind: 'user', position: 1, email: 'owner@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: account.sendEmail, lastVerifiedAt: null,
    },
  })),
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

import { googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const lunch = { title: 'Lunch', start: '2030-01-02T12:00:00-05:00', end: '2030-01-02T13:00:00-05:00' };

beforeEach(() => {
  vi.mocked(googleWrite).mockClear();
  account.sendEmail = true;
});

describe('an event with guests', () => {
  it('asks Google to email the guests an invitation', async () => {
    const out = await executeGoogleWriteTool('user_calendar_create', { ...lunch, attendees: ['friend@example.com'] }, 'agent-1', 'Agent One');
    expect(out).toContain('created');
    expect(String(vi.mocked(googleWrite).mock.calls[0][1])).toContain('sendUpdates=all');
  });

  it('adds the guests without an email when notify_guests is false', async () => {
    await executeGoogleWriteTool('user_calendar_create', { ...lunch, attendees: ['friend@example.com'], notify_guests: false }, 'agent-1', 'Agent One');
    expect(String(vi.mocked(googleWrite).mock.calls[0][1])).not.toContain('sendUpdates');
  });

  it('is refused when the account may not send, and nothing is created', async () => {
    account.sendEmail = false;
    const out = await executeGoogleWriteTool('user_calendar_create', { ...lunch, attendees: ['friend@example.com'] }, 'agent-1', 'Agent One');
    expect(out).toBe('Error: "The agent may send as me" is off for owner@example.com, and this invitation to the guests would be sent from it. Turn it on in Settings → Channels (the Google cards), then try again.');
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('an event with no guests is created even when the account may not send', async () => {
    account.sendEmail = false;
    const out = await executeGoogleWriteTool('user_calendar_create', lunch, 'agent-1', 'Agent One');
    expect(out).toContain('created');
    expect(String(vi.mocked(googleWrite).mock.calls[0][1])).not.toContain('sendUpdates');
  });

  it('a meeting reply is refused when the account may not send', async () => {
    account.sendEmail = false;
    const out = await executeGoogleWriteTool('user_calendar_respond_invite', { event_id: 'ev1', response: 'accepted', attendee_email: 'owner@example.com' }, 'agent-1', 'Agent One');
    expect(out).toBe('Error: "The agent may send as me" is off for owner@example.com, and this meeting reply would be sent from it. Turn it on in Settings → Channels (the Google cards), then try again.');
    expect(googleWrite).not.toHaveBeenCalled();
  });
});
