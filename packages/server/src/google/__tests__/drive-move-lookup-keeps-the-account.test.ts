// A `drive_move` without `old_parent_id` first GETs the file's current parents
// so it can remove them. That lookup ran on the agent's account by default even
// when the move itself travelled on `slot`, so `user_drive_move` looked the file
// up in the AGENT's Drive: "File not found" for a file that exists in the
// owner's Drive, or a wrong-parents removal if the agent can see the file.
// The lookup must travel on the same account as the move.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  googleRead: vi.fn(async () => ({ ok: true, data: { parents: ['p1'] }, error: null, apiEndpoint: 'x' })),
  googleWrite: vi.fn(async () => ({ ok: true, data: { id: 'f1', name: 'Doc', parents: ['p2'] }, error: null, apiEndpoint: 'x' })),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'acct-user', kind: 'user', position: 1, email: 'owner@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

import { googleRead, googleWrite } from '../client.js';
import { writeToolReceipt } from '../../receipts/store.js';
import { executeGoogleWriteTool } from '../tools-write.js';

beforeEach(() => {
  vi.mocked(googleRead).mockClear();
  vi.mocked(googleWrite).mockClear();
  vi.mocked(writeToolReceipt).mockClear();
});

describe('drive_move — the parents lookup keeps the account', () => {
  it('a user move looks the parents up on the resolved account and removes them', async () => {
    const out = await executeGoogleWriteTool('user_drive_move', { file_id: 'f1', new_parent_id: 'p2' }, 'agent-1', 'Agent One');
    expect(out).toContain('moved into folder p2');

    const reads = vi.mocked(googleRead).mock.calls;
    expect(reads).toHaveLength(1);
    expect(reads[0][5]).toBe('acct-user');

    const url = String(vi.mocked(googleWrite).mock.calls[0][1]);
    expect(url).toContain('removeParents=p1');
    expect(url).toContain('addParents=p2');
  });
});
