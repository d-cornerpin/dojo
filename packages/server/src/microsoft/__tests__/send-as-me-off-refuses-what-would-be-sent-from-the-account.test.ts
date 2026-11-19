// One switch per Microsoft account, "The agent may send as me", covers everything sent from it: mail,
// meeting replies, invitations to guests, file invitations and Teams posts. With it off each is refused
// with a plain reason and nothing reaches Microsoft; with it on each goes as before.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const account = { sendEmail: false };
vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  msGraphWrite: vi.fn(async () => ({ ok: true, data: { id: 'x1' }, error: null })),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForTool: vi.fn(() => ({
    account: { id: 'acct-1', kind: 'user', email: 'owner@example.com', connected: true, sendEmail: account.sendEmail },
  })),
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

import { msGraphWrite } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const refusal = (what: string) =>
  `Error: "The agent may send as me" is off for owner@example.com, and this ${what} would be sent from it. Turn it on in Settings → Channels (the Microsoft cards), then try again.`;

const cases: Array<[string, Record<string, unknown>, string]> = [
  ['user_calendar_create_ms', { title: 'Lunch', start: '2030-01-02T12:00:00', end: '2030-01-02T13:00:00', attendees: ['friend@example.com'] }, 'invitation to the guests'],
  ['user_calendar_respond_invite_ms', { event_id: 'ev1', response: 'accept' }, 'meeting reply'],
  ['user_onedrive_share', { file_id: 'f1', type: 'invite', email: 'friend@example.com' }, 'file invitation'],
  ['user_teams_send_message', { chat_id: 'c1', message: 'hello' }, 'Teams post'],
  ['user_teams_send_channel_message', { team_id: 't1', channel_id: 'ch1', message: 'hello' }, 'Teams post'],
];

beforeEach(() => {
  vi.mocked(msGraphWrite).mockClear();
  account.sendEmail = false;
});

describe('send as me off', () => {
  it.each(cases)('%s is refused and nothing is sent', async (name, args, what) => {
    const out = await executeMicrosoftWriteTool(name, args, 'agent-1', 'Agent One');
    expect(out).toBe(refusal(what));
    expect(msGraphWrite).not.toHaveBeenCalled();
  });

  it('an event with no guests and a link share still work', async () => {
    const event = await executeMicrosoftWriteTool('user_calendar_create_ms', { title: 'Focus', start: '2030-01-02T12:00:00', end: '2030-01-02T13:00:00' }, 'agent-1', 'Agent One');
    expect(event).toContain('created');
    const link = await executeMicrosoftWriteTool('user_onedrive_share', { file_id: 'f1' }, 'agent-1', 'Agent One');
    expect(link).toContain('Sharing link created');
  });

  it.each(cases)('%s goes out when the switch is on', async (name, args) => {
    account.sendEmail = true;
    const out = await executeMicrosoftWriteTool(name, args, 'agent-1', 'Agent One');
    expect(out.startsWith('Error')).toBe(false);
    expect(msGraphWrite).toHaveBeenCalled();
  });
});
