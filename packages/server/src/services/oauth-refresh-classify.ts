// ════════════════════════════════════════
// services/oauth-refresh-classify.ts — is a token-refresh failure terminal?
//
// Both the Microsoft and Google auth layers refresh access tokens against an
// OAuth 2.0 token endpoint. When a refresh FAILS we must decide exactly one
// thing: is the account genuinely dead (the refresh token was revoked/expired,
// or the user must interactively re-consent) — in which case we bench it and
// tell the owner to re-authenticate — or is this a passing hiccup (5xx,
// throttling, clock skew, an intermittent server-side AADSTS error, a network
// blip) that clears on its own?
//
// LIVE INCIDENT (2026-07-08): a healthy Microsoft account went from flowing
// mail to connected=0 after a SINGLE bad refresh response, with no automatic
// way back — a human had to re-auth in Settings. Root cause: the old code
// benched on ANY 400/401 without reading the body. This classifier fixes the
// cause: bench ONLY on an unmistakable terminal OAuth error; treat everything
// else as transient (keep the account connected, let the caller's null-return
// handle THIS call, and let the recovery probe re-test later).
//
// Pure + dependency-free on purpose, so it is unit-testable in isolation.
// ════════════════════════════════════════

/**
 * OAuth 2.0 / OpenID Connect token-endpoint `error` codes that mean a silent
 * refresh can NEVER recover on its own — the human must re-consent or re-auth.
 * These are the ONLY codes that bench an account. Conservative by design: an
 * unrecognized code is treated as transient, so a healthy account is never
 * benched by a code we did not anticipate.
 */
const TERMINAL_OAUTH_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  // RFC 6749 section 5.2: the refresh token itself is invalid, expired, or
  // revoked. This is THE terminal signal for both providers. Google returns it
  // as ("Token has been expired or revoked"); Microsoft folds its expiry/revoke
  // AADSTS codes into the same top-level error (AADSTS700082 inactivity-expiry,
  // AADSTS70008 expired/revoked, AADSTS50173 password-changed/grant-revoked).
  'invalid_grant',
  // OIDC / Azure AD: the user must interactively sign in again (MFA prompt,
  // conditional-access, password change). A background refresh cannot satisfy it.
  'interaction_required',
  // OIDC / Azure AD: user or admin consent is required. A background refresh
  // cannot grant consent, so this needs a human trip through Settings.
  'consent_required',
  // OIDC: the end user must log in. Same class as interaction_required — there
  // is no silent path back from it.
  'login_required',
]);

/**
 * Classify a FAILED token-refresh response. `status` is the HTTP status code
 * (use 0 for a network failure that never produced a response); `body` is the
 * raw response text (JSON per RFC 6749, but read defensively).
 *
 * Returns 'terminal' ONLY for an unmistakable dead-account signal. Everything
 * else — 5xx, 429, network failure, temporarily_unavailable, unrecognized 400s,
 * and unparseable/garbage bodies — is 'transient'.
 */
export function classifyTokenRefreshFailure(status: number, body: string): 'terminal' | 'transient' {
  // Server-side failures are never the account's fault: 5xx (service down or
  // overloaded) and 429 (throttling) always retry on a later cycle.
  if (status >= 500) return 'transient';
  if (status === 429) return 'transient';

  // Only a 4xx carrying a recognized terminal OAuth error benches. Parse
  // defensively: a body we cannot read as JSON with a string `error` cannot be
  // an unmistakable terminal signal, so it stays transient.
  let code: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string') code = parsed.error.trim().toLowerCase();
  } catch {
    return 'transient';
  }
  if (code && TERMINAL_OAUTH_REFRESH_ERRORS.has(code)) return 'terminal';
  return 'transient';
}
