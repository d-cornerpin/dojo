// gmail_label with nothing to change used to POST an empty modify and report success
// (GitHub #21): a worker that mis-named its arguments believed the job was done.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
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

import { googleRead, googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const run = (args: Record<string, unknown>) => executeGoogleWriteTool('gmail_label', args, 'agent-1', 'A Worker');

beforeEach(() => {
  vi.mocked(googleRead).mockReset();
  vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok({ id: 'm1' }) as never);
});

describe('gmail_label refuses a change that changes nothing', () => {
  const NAMES = ['add_labels', 'remove_labels', 'message_id', 'message_ids', 'thread_id', 'thread_ids'];

  it('no add_labels and no remove_labels: an Error naming every argument, and nothing is sent', async () => {
    const out = await run({ message_id: 'm1' });
    expect(out).toMatch(/^Error: nothing to change/);
    for (const n of NAMES) expect(out).toContain(n);
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('both arrays empty: the same refusal', async () => {
    const out = await run({ message_id: 'm1', add_labels: [], remove_labels: [] });
    expect(out).toMatch(/^Error: nothing to change/);
    expect(googleWrite).not.toHaveBeenCalled();
  });

  it('a call that adds a label proceeds', async () => {
    const out = await run({ message_id: 'm1', add_labels: ['X'] });
    expect(out).not.toMatch(/^Error/);
    expect(googleWrite).toHaveBeenCalledTimes(1);
  });
});
