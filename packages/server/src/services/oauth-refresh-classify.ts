// Classifies a failed OAuth token refresh: terminal (dead refresh token or re-consent needed, so bench the account
// and tell the owner) or transient (5xx, throttling, clock skew, network blip, so keep it connected and retry).

/** Token-endpoint `error` codes a silent refresh can never recover from; the only codes that bench an account. */
const TERMINAL_OAUTH_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  // The refresh token is invalid, expired or revoked (Microsoft folds its AADSTS expiry codes into this).
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);

/** Classify a FAILED refresh (`status` 0 for a network failure): 'terminal' only for an unmistakable dead account. */
export function classifyTokenRefreshFailure(status: number, body: string): 'terminal' | 'transient' {
  if (status >= 500) return 'transient';
  if (status === 429) return 'transient';

  // Only a 4xx with a recognized terminal error benches; a body that is not JSON with a string `error` stays transient.
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
