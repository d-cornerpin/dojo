// Microsoft calendar create/update always sent the host timezone, so a meeting
// "10:00 in London" from a box running in another zone landed hours off with a
// success message. The Google twins take an optional IANA `timezone` param;
// these must too, and a zone name Intl rejects must never reach Graph.

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

const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const sentBody = () =>
  vi.mocked(msGraphWrite).mock.calls[0][2] as { start: { timeZone: string }; end?: { timeZone: string } };

beforeEach(() => {
  vi.mocked(msGraphWrite).mockClear();
});

describe('calendar_create_ms — honours a named time zone', () => {
  it('sends the supplied zone on start and end', async () => {
    const out = await executeMicrosoftWriteTool('calendar_create_ms', {
      title: 'Standup',
      start: '2026-03-25T10:00:00',
      end: '2026-03-25T11:00:00',
      timezone: 'Europe/London',
    }, 'agent-1', 'Agent One');
    expect(out).toContain('created');
    expect(msGraphWrite).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body.start.timeZone).toBe('Europe/London');
    expect(body.end?.timeZone).toBe('Europe/London');
  });

  it('without timezone keeps the host zone', async () => {
    await executeMicrosoftWriteTool('calendar_create_ms', {
      title: 'Standup',
      start: '2026-03-25T10:00:00',
      end: '2026-03-25T11:00:00',
    }, 'agent-1', 'Agent One');
    const body = sentBody();
    expect(body.start.timeZone).toBe(HOST_TZ);
    expect(body.end?.timeZone).toBe(HOST_TZ);
  });

  it('a zone name Intl.DateTimeFormat rejects is refused, nothing sent', async () => {
    const out = await executeMicrosoftWriteTool('calendar_create_ms', {
      title: 'Standup',
      start: '2026-03-25T10:00:00',
      end: '2026-03-25T11:00:00',
      timezone: 'Mars/Base',
    }, 'agent-1', 'Agent One');
    expect(out).toMatch(/^Error:/);
    expect(msGraphWrite).not.toHaveBeenCalled();
  });
});

describe('calendar_update_ms — honours a named time zone', () => {
  it('patches only the supplied start with the supplied zone, no end key', async () => {
    const out = await executeMicrosoftWriteTool('calendar_update_ms', {
      event_id: 'ev1',
      start: '2026-03-25T10:00:00',
      timezone: 'Asia/Tokyo',
    }, 'agent-1', 'Agent One');
    expect(out).toBe('Calendar event ev1 updated');
    const patch = sentBody();
    expect(patch.start.timeZone).toBe('Asia/Tokyo');
    expect(patch).not.toHaveProperty('end');
  });
});

describe('the ms calendar schemas name the knob', () => {
  it('both tools list a string `timezone` property', () => {
    for (const name of ['calendar_create_ms', 'calendar_update_ms']) {
      const def = microsoftWriteToolDefinitions.find((d) => d.name === name);
      const props = (def?.input_schema as { properties?: Record<string, unknown> }).properties;
      expect(props?.timezone).toBeTruthy();
    }
  });
});
