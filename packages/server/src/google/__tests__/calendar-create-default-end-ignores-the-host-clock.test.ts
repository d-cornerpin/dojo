// calendar_create derives a one-hour end for a timed start that omits one.
//
// The start is sent as a wall-clock time in the EVENT's zone ({ dateTime, timeZone }),
// so the end must be the same wall clock plus one hour. v35 added a real hour in the
// HOST's zone and re-read the host's wall clock, then labeled it with the event's zone —
// which is a zero- or two-hour event on a host DST change, or whenever the event zone
// differs from the host zone on that zone's change days. The end must not depend on the
// host clock at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The host must be a zone other than UTC (and other than the event zones used below)
// BEFORE tools-write.js loads, so HOST_TIMEZONE and the host-local Date parse are live.
vi.hoisted(() => {
  process.env.TZ = 'America/Los_Angeles';
});

vi.mock('../client.js', () => ({
  googleRead: vi.fn(),
  googleWrite: vi.fn(async () => ({ ok: true, data: { id: 'ev1', htmlLink: 'https://example.test/ev1' }, error: null, apiEndpoint: 'x' })),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

import { googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

beforeEach(() => {
  vi.mocked(googleWrite).mockClear();
});

const postedEvent = (): Record<string, unknown> =>
  vi.mocked(googleWrite).mock.calls[0][2] as Record<string, unknown>;

describe('calendar_create — the default one-hour end is the event zone, not the host clock', () => {
  it('host-zone DST fall-back: 01:30 start gives a 02:30 end, not a zero-length event', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-11-01T01:30:00', timezone: 'America/Los_Angeles' }, 'agent-1', 'Agent One');
    expect(postedEvent().end).toEqual({ dateTime: '2026-11-01T02:30:00', timeZone: 'America/Los_Angeles' });
  });

  it('event zone differs from a host DST spring-forward: 01:30 Tokyo start gives a 02:30 end', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-03-08T01:30:00', timezone: 'Asia/Tokyo' }, 'agent-1', 'Agent One');
    expect(postedEvent().end).toEqual({ dateTime: '2026-03-08T02:30:00', timeZone: 'Asia/Tokyo' });
  });

  it('an ordinary timed start still gets exactly +1h', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-06-15T09:00:00', timezone: 'America/Los_Angeles' }, 'agent-1', 'Agent One');
    expect(postedEvent().end).toEqual({ dateTime: '2026-06-15T10:00:00', timeZone: 'America/Los_Angeles' });
  });

  it('the +1h rolls over midnight into the next day', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-12-31T23:30:00', timezone: 'UTC' }, 'agent-1', 'Agent One');
    expect(postedEvent().end).toEqual({ dateTime: '2027-01-01T00:30:00', timeZone: 'UTC' });
  });

  it('an offset-carrying start is untouched: UTC instant +1h, no timeZone field', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-06-15T09:00:00-07:00' }, 'agent-1', 'Agent One');
    const event = postedEvent();
    expect(event.start).toEqual({ dateTime: '2026-06-15T09:00:00-07:00' });
    expect(event.end).toEqual({ dateTime: '2026-06-15T17:00:00.000Z' });
  });

  it('a date-only start stays an all-day event with an exclusive +1-day end', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-02-28' }, 'agent-1', 'Agent One');
    const event = postedEvent();
    expect(event.start).toEqual({ date: '2026-02-28' });
    expect(event.end).toEqual({ date: '2026-03-01' });
  });

  it('an explicit end is never replaced by the default', async () => {
    await executeGoogleWriteTool('calendar_create', { title: 'T', start: '2026-06-15T09:00:00', end: '2026-06-15T09:45:00', timezone: 'UTC' }, 'agent-1', 'Agent One');
    expect(postedEvent().end).toEqual({ dateTime: '2026-06-15T09:45:00', timeZone: 'UTC' });
  });
});
