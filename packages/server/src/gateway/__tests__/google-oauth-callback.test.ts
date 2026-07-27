// PHASE-0 T12b (P350): the unauthenticated OAuth callback must not reflect
// attacker text into its HTML response.
//
// `/api/google/callback` is in ALWAYS_PUBLIC_PATHS — it has to be, the provider
// redirects a browser there with no credential to present — and it answers with
// hand-built HTML. Before this task the `error` query param went into that HTML
// raw, so `/api/google/callback?error=<script>...</script>` executed script on
// the server's origin. In production the dashboard is served from that same
// origin (gateway/server.ts SPA fallback), which is where the httpOnly session
// cookie and the localStorage token live.
//
// Three values reach the response and all three are asserted here:
//   1. `error`         — the query param, fully attacker-controlled
//   2. `result.email`  — relayed from the token exchange
//   3. `result.error`  — relayed from the token exchange
// Fixing one and leaving two is the failure mode this suite exists to prevent.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const exchange = vi.fn();
const flowForState = vi.fn();

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../google/auth.js', () => ({
  getGoogleWorkspaceConfig: vi.fn(),
  testGoogleAuth: vi.fn(),
  setGoogleConnected: vi.fn(),
  setGoogleEnabled: vi.fn(),
  setEnabledServices: vi.fn(),
  buildAuthUrl: vi.fn(),
  exchangeCodeForTokens: (...args: unknown[]) => exchange(...args),
  getFlowForState: (...args: unknown[]) => flowForState(...args),
  clearOAuthFlow: vi.fn(),
  disconnectGoogle: vi.fn(),
  disconnectGoogleAccount: vi.fn(),
  getMissingScopes: vi.fn(() => []),
  discoverGrantedScopes: vi.fn(),
  isEmailMonitoringEnabled: vi.fn(() => false),
  setEmailMonitoringEnabled: vi.fn(),
  setEmailMonitoringEnabledForAccount: vi.fn(),
  isEmailSendingEnabled: vi.fn(() => false),
  setEmailSendingEnabled: vi.fn(),
  setEmailSendingEnabledForAccount: vi.fn(),
  setEnabledServicesForAccount: vi.fn(),
  listGoogleAccountViews: vi.fn(() => []),
  ACCOUNT_SLOTS: ['agent', 'user'],
}));

vi.mock('../../google/accounts.js', () => ({
  getGoogleAccount: vi.fn(),
  getPrimaryGoogleAccount: vi.fn(),
  countGoogleAccounts: vi.fn(() => 0),
  MAX_ACCOUNTS_PER_KIND: 3,
}));

vi.mock('../../google/activity-log.js', () => ({
  queryGoogleActivity: vi.fn(() => []),
  getTodayActivityCounts: vi.fn(() => ({})),
  getLastActivityTimestamp: vi.fn(() => null),
}));

const XSS = '<script>alert(1)</script>';

/** Hit GET /callback on the real router with the given query string. */
async function callback(query: string): Promise<string> {
  const { googleRouter } = await import('../routes/google.js');
  const res = await googleRouter.request(`/callback?${query}`);
  return res.text();
}

describe('PHASE-0 T12b — google OAuth callback HTML reflection', () => {
  beforeEach(() => {
    exchange.mockReset();
    flowForState.mockReset();
  });

  it('escapes the attacker-controlled `error` query param', async () => {
    const body = await callback(`error=${encodeURIComponent(XSS)}`);

    // The payload must not survive as markup...
    expect(body).not.toContain(XSS);
    expect(body).not.toContain('<script>alert(1)</script>');
    // ...but it must still be readable as text, so the owner sees the real error.
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The page's own close-the-tab script is the ONLY script tag left.
    expect(body.match(/<script>/g)).toHaveLength(1);
    expect(body).toContain('<script>window.close()</script>');
  });

  it('escapes every HTML metacharacter, not just angle brackets', async () => {
    const body = await callback(`error=${encodeURIComponent(`" '&<>`)}`);
    expect(body).toContain('&quot; &#39;&amp;&lt;&gt;');
  });

  it('escapes the email relayed from a successful token exchange', async () => {
    flowForState.mockReturnValue({
      redirectUri: 'http://localhost:3001/api/google/callback',
      verifier: 'v', target: { kind: 'user' },
    });
    exchange.mockResolvedValue({ success: true, email: `evil${XSS}@example.com` });

    const body = await callback('code=abc&state=s');
    expect(body).not.toContain(XSS);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body.match(/<script>/g)).toHaveLength(1);
  });

  it('escapes the error relayed from a failed token exchange', async () => {
    flowForState.mockReturnValue({
      redirectUri: 'http://localhost:3001/api/google/callback',
      verifier: 'v', target: { kind: 'agent' },
    });
    exchange.mockResolvedValue({ success: false, error: `bad_grant ${XSS}` });

    const body = await callback('code=abc&state=s');
    expect(body).not.toContain(XSS);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script>'); // this branch has no close-tab script
  });

  it('leaves the no-interpolation branches alone', async () => {
    // Missing code/state, and unknown state: static HTML, nothing reflected.
    expect(await callback('')).toContain('Missing authorization code or state');
    flowForState.mockReturnValue(undefined);
    const unknown = await callback(`code=a&state=${encodeURIComponent(XSS)}`);
    expect(unknown).toContain('Invalid state parameter');
    expect(unknown).not.toContain(XSS);
    expect(unknown).not.toContain('alert(1)'); // `state` is logged, never rendered
  });
});
