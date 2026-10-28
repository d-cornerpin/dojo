// An event with no title (a quick block dropped on a calendar, a private slot seen
// through a shared calendar) carries NO `summary` field in Google's response. Both
// calendar renderers printed that missing field verbatim, so the agent read the word
// `undefined` back as the event's name.
//
//   * `calendar_agenda` (agenda line `- ${e.title}`) shows `(no title)`;
//   * `calendar_search` (result line `- ${e.summary}`) shows `(no title)`;
//   * a normal title prints unchanged in both.
//
// Driven through the real tool door (`executeGoogleReadTool`); only the HTTP client,
// the account resolver and the F4 other-surface sections are doubles.
import { describe, it, expect, vi } from 'vitest';

const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { items: [] as unknown[] } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));
vi.mock('../../tools/unified-read.js', () => ({
  otherCalendarsAgendaSection: async () => '',
  otherMailboxesCountSection: async () => '',
}));

const { executeGoogleReadTool } = await import('../tools-read.js');

/** One event as Google returns it. `summary` is absent exactly when the event has no title. */
function event(summary?: string): Record<string, unknown> {
  return {
    id: 'e1',
    start: { dateTime: '2026-03-02T10:00:00-05:00' },
    end: { dateTime: '2026-03-02T11:00:00-05:00' },
    ...(summary === undefined ? {} : { summary }),
  };
}

function respondWith(items: unknown[]): void {
  googleRead.mockImplementation(async () => ({ ok: true as const, data: { items } }));
}

describe('a calendar event with no title', () => {
  it('is shown as (no title) in the agenda, never as "undefined"', async () => {
    respondWith([event()]);
    const out = await executeGoogleReadTool('calendar_agenda', { days: 1 }, 'agent-1', 'Agent');
    expect(out).toContain('- (no title)');
    expect(out).not.toContain('undefined');
  });

  it('is shown as (no title) in search results, never as "undefined"', async () => {
    respondWith([event()]);
    const out = await executeGoogleReadTool('calendar_search', { query: 'x' }, 'agent-1', 'Agent');
    expect(out).toContain('- (no title)');
    expect(out).toContain('[ID: e1]');
    expect(out).not.toContain('undefined');
  });

  it('a whitespace-only title is shown as (no title) too', async () => {
    respondWith([event('   ')]);
    const out = await executeGoogleReadTool('calendar_agenda', { days: 1 }, 'agent-1', 'Agent');
    expect(out).toContain('- (no title)');
  });
});

describe('a calendar event with a title', () => {
  it('prints unchanged in the agenda and in search', async () => {
    respondWith([event('Standup')]);
    const agenda = await executeGoogleReadTool('calendar_agenda', { days: 1 }, 'agent-1', 'Agent');
    expect(agenda).toContain('- Standup');
    const search = await executeGoogleReadTool('calendar_search', { query: 'x' }, 'agent-1', 'Agent');
    expect(search).toContain('- Standup');
  });
});
