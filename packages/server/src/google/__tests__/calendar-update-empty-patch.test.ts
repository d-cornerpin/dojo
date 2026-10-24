// B11 — an empty calendar patch is refused, not sent.
//
// `calendar_update` built its patch from only the fields the caller supplied, then PATCHed it
// even when the patch was `{}` and wrote a VERIFIED receipt for a change that changed nothing.
// A typical owner calls that a lie: the agent said "updated" and the event is untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { writeToolReceipt } from '../../receipts/store.js';
import { executeGoogleWriteTool } from '../tools-write.js';

beforeEach(() => {
  vi.mocked(googleWrite).mockClear();
  vi.mocked(writeToolReceipt).mockClear();
});

describe('calendar_update — nothing to change', () => {
  it('only event_id: refuses with the nothing-to-change error, sends no PATCH, writes no receipt', async () => {
    const out = await executeGoogleWriteTool('calendar_update', { event_id: 'ev1' }, 'agent-1', 'Agent One');
    expect(out).toMatch(/^Error: nothing to change/);
    expect(out).toContain('title');
    expect(out).toContain('start');
    expect(out).toContain('description');
    expect(googleWrite).not.toHaveBeenCalled();
    expect(writeToolReceipt).not.toHaveBeenCalled();
  });

  it('a timezone alone changes nothing either', async () => {
    const out = await executeGoogleWriteTool('calendar_update', { event_id: 'ev1', timezone: 'UTC', calendar_id: 'primary' }, 'agent-1', 'Agent One');
    expect(out).toMatch(/^Error: nothing to change/);
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('one real field still patches, and the receipt is written', async () => {
    const out = await executeGoogleWriteTool('calendar_update', { event_id: 'ev1', title: 'New name' }, 'agent-1', 'Agent One');
    expect(out).toBe('Calendar event ev1 updated');
    expect(googleWrite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(googleWrite).mock.calls[0][2]).toEqual({ summary: 'New name' });
    expect(writeToolReceipt).toHaveBeenCalledTimes(1);
  });
});
