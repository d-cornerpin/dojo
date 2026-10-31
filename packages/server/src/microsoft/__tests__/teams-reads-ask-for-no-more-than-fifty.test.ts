// Graph accepts at most 50 for `$top` on chat and channel messages — a larger value answers
// HTTP 400 "Top value must be less than or equal to 50". teams_list_chats already clamped its
// max_results to 50, but teams_read_messages and teams_read_channel_messages interpolated the
// caller's number straight into `$top=`, so an agent asking for "the last 100 messages" got the
// 400 error and no messages at all. Both now clamp the value into 1..50.

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

/** The endpoint of the first msGraphRead call. */
const firstUrl = () => String(vi.mocked(msGraphRead).mock.calls[0][0]);
/** The raw text of the endpoint's `$top=` parameter, or null when absent. */
const topValue = () => firstUrl().match(/\$top=([^&]*)/)?.[1] ?? null;

const TOOLS: Array<[string, Record<string, unknown>]> = [
  ['teams_read_messages', { chat_id: '19:abc@thread.v2' }],
  ['teams_read_channel_messages', { team_id: 'team-1', channel_id: '19:chan@thread.tacv2' }],
];

describe('Teams message reads — $top stays inside what Graph allows', () => {
  for (const [tool, required] of TOOLS) {
    it(`${tool}: max_results above 50 is clamped to 50`, async () => {
      await executeMicrosoftReadTool(tool, { ...required, max_results: 100 }, 'agent-1', 'Agent One');
      expect(firstUrl()).toContain('$top=50');
      expect(topValue()).toBe('50');
    });

    it(`${tool}: max_results inside the range passes through`, async () => {
      await executeMicrosoftReadTool(tool, { ...required, max_results: 20 }, 'agent-1', 'Agent One');
      expect(topValue()).toBe('20');
    });

    it(`${tool}: no max_results keeps the default 10`, async () => {
      await executeMicrosoftReadTool(tool, { ...required }, 'agent-1', 'Agent One');
      expect(topValue()).toBe('10');
    });

    it(`${tool}: max_results 0 is raised to 1`, async () => {
      await executeMicrosoftReadTool(tool, { ...required, max_results: 0 }, 'agent-1', 'Agent One');
      expect(topValue()).toBe('1');
    });
  }
});
