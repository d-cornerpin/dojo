// 9213 — Graph reads an online-meeting startDateTime/endDateTime WITHOUT an offset as UTC.
//
// `online_meeting_create` / `online_meeting_update` sent the caller's string as it came, so an
// agent that asks for "2pm" and passes '2026-05-10T14:00:00' created the meeting at 14:00 UTC:
// hours off for the owner, answered with a success message. The Google freebusy tool already
// solves this with `toRfc3339WithOffset` (moved here from google/tools-read.ts): a value that
// already carries an offset passes through; anything else is host-local time re-emitted as an
// exact UTC instant. The TZ is pinned below so the conversion is checked against one zone.

process.env.TZ = 'America/Los_Angeles';

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

function sentBody(): Record<string, unknown> {
  expect(msGraphWrite).toHaveBeenCalledTimes(1);
  return vi.mocked(msGraphWrite).mock.calls[0][2] as Record<string, unknown>;
}

describe('online_meeting_create — an offset-less time is host-local, not UTC', () => {
  it('offset-less start/end become exact UTC instants (14:00 PDT = 21:00Z)', async () => {
    const out = await executeMicrosoftWriteTool('online_meeting_create', {
      subject: 'Sync', start: '2026-05-10T14:00:00', end: '2026-05-10T15:00:00',
    }, 'agent-1', 'Agent One');
    expect(out).toContain('created');
    const body = sentBody();
    expect(body.startDateTime).toBe('2026-05-10T21:00:00.000Z');
    expect(body.endDateTime).toBe('2026-05-10T22:00:00.000Z');
  });

  it('a value that already carries Z passes through unchanged', async () => {
    await executeMicrosoftWriteTool('online_meeting_create', {
      subject: 'Sync', start: '2026-05-10T14:00:00Z', end: '2026-05-10T15:00:00Z',
    }, 'agent-1', 'Agent One');
    const body = sentBody();
    expect(body.startDateTime).toBe('2026-05-10T14:00:00Z');
    expect(body.endDateTime).toBe('2026-05-10T15:00:00Z');
  });

  it('a value that already carries +01:00 passes through unchanged', async () => {
    await executeMicrosoftWriteTool('online_meeting_create', {
      subject: 'Sync', start: '2026-05-10T14:00:00+01:00', end: '2026-05-10T15:00:00+01:00',
    }, 'agent-1', 'Agent One');
    const body = sentBody();
    expect(body.startDateTime).toBe('2026-05-10T14:00:00+01:00');
    expect(body.endDateTime).toBe('2026-05-10T15:00:00+01:00');
  });
});

describe('online_meeting_update — the patch converts only the supplied time', () => {
  it('offset-less start alone: converted, and no endDateTime is added', async () => {
    const out = await executeMicrosoftWriteTool('online_meeting_update', {
      meeting_id: 'mt1', start: '2026-05-10T14:00:00',
    }, 'agent-1', 'Agent One');
    expect(out).toContain('updated');
    const patch = sentBody();
    expect(patch.startDateTime).toBe('2026-05-10T21:00:00.000Z');
    expect(patch).not.toHaveProperty('endDateTime');
  });
});

describe('toRfc3339WithOffset — the moved helper (src/services/rfc3339-offset.ts)', () => {
  it('date-only gives midnight local as an exact UTC instant; garbage returns as it came', async () => {
    const { toRfc3339WithOffset } = await import('../../services/rfc3339-offset.js');
    expect(toRfc3339WithOffset('2026-05-10')).toBe('2026-05-10T07:00:00.000Z');
    expect(toRfc3339WithOffset('not a time')).toBe('not a time');
  });
});
