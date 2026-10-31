// A token endpoint that accepts the connection and never answers must not hang
// the ONE shared refresh promise for an account — every Gmail/Calendar/Drive
// call for that account waits behind it, and the callers' own timeouts only
// start after the token is obtained. The refresh fetch must carry its own
// deadline, like the other fetches in auth.ts already do.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake account: connected, expired access token, holds a refresh token.
const account = {
  id: 'acct-refresh',
  kind: 'agent' as const,
  position: 1,
  email: 'agent@example.invalid',
  connected: true,
  accessToken: 'expired-access-token',
  refreshToken: 'fake-refresh',
  tokenExpiresAt: Date.now() - 10_000,
};
const accounts: Record<string, typeof account> = { [account.id]: account };

vi.mock('../accounts.js', () => ({
  getGoogleAccount: vi.fn((id: string) => accounts[id] ?? null),
  updateGoogleAccount: vi.fn((id: string, patch: Record<string, unknown>) => { Object.assign(accounts[id], patch); }),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { getValidAccessTokenForAccount } from '../auth.js';

const fetchStub = vi.fn();

beforeEach(() => {
  account.connected = true;
  account.accessToken = 'expired-access-token';
  account.tokenExpiresAt = Date.now() - 10_000;
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google token refresh has a deadline', () => {
  it('sends the refresh request with an AbortSignal', async () => {
    fetchStub.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }) });
    const token = await getValidAccessTokenForAccount(account.id);
    expect(token).toBe('fresh-token');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const init = fetchStub.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a timed-out refresh returns null and leaves the account connected', async () => {
    fetchStub.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const token = await getValidAccessTokenForAccount(account.id);
    expect(token).toBeNull();
    expect(account.connected).toBe(true);
  });
});
