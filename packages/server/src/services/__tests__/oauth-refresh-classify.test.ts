import { describe, it, expect } from 'vitest';
import { classifyTokenRefreshFailure } from '../oauth-refresh-classify.js';

describe('classifyTokenRefreshFailure', () => {
  // ── Terminal: unmistakable dead-account signals ──

  it('treats a Google invalid_grant 400 as terminal', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    expect(classifyTokenRefreshFailure(400, body)).toBe('terminal');
  });

  it('treats a Microsoft invalid_grant 400 (AADSTS expiry) as terminal', () => {
    const body = JSON.stringify({
      error: 'invalid_grant',
      error_description: "AADSTS700082: The refresh token has expired due to inactivity.",
      error_codes: [700082],
    });
    expect(classifyTokenRefreshFailure(400, body)).toBe('terminal');
  });

  it('treats interaction_required as terminal', () => {
    const body = JSON.stringify({ error: 'interaction_required', error_description: 'AADSTS50076: MFA required.' });
    expect(classifyTokenRefreshFailure(400, body)).toBe('terminal');
  });

  it('treats consent_required as terminal', () => {
    expect(classifyTokenRefreshFailure(400, JSON.stringify({ error: 'consent_required' }))).toBe('terminal');
  });

  it('treats login_required as terminal', () => {
    expect(classifyTokenRefreshFailure(401, JSON.stringify({ error: 'login_required' }))).toBe('terminal');
  });

  it('matches the terminal code case-insensitively', () => {
    expect(classifyTokenRefreshFailure(400, JSON.stringify({ error: 'Invalid_Grant' }))).toBe('terminal');
  });

  // ── Transient: never bench a healthy account on a passing hiccup ──

  it('treats an AADSTS 500-class server error as transient', () => {
    const body = JSON.stringify({ error: 'temporarily_unavailable', error_description: 'AADSTS90033: A transient error has occurred.' });
    expect(classifyTokenRefreshFailure(500, body)).toBe('transient');
  });

  it('treats a 503 with any body as transient', () => {
    expect(classifyTokenRefreshFailure(503, JSON.stringify({ error: 'invalid_grant' }))).toBe('transient');
  });

  it('treats a 429 throttling response as transient', () => {
    expect(classifyTokenRefreshFailure(429, JSON.stringify({ error: 'invalid_grant' }))).toBe('transient');
  });

  it('treats a garbage-body 400 as transient', () => {
    expect(classifyTokenRefreshFailure(400, '<html>Bad Gateway</html>')).toBe('transient');
  });

  it('treats an empty-body 400 as transient', () => {
    expect(classifyTokenRefreshFailure(400, '')).toBe('transient');
  });

  it('treats a network error (status 0, no body) as transient', () => {
    expect(classifyTokenRefreshFailure(0, '')).toBe('transient');
  });

  it('treats an unrecognized 400 error code as transient', () => {
    expect(classifyTokenRefreshFailure(400, JSON.stringify({ error: 'temporarily_unavailable' }))).toBe('transient');
  });

  it('treats invalid_client (platform config, not per-account) as transient', () => {
    expect(classifyTokenRefreshFailure(400, JSON.stringify({ error: 'invalid_client' }))).toBe('transient');
  });

  it('treats a 400 whose error field is not a string as transient', () => {
    expect(classifyTokenRefreshFailure(400, JSON.stringify({ error: { code: 1 } }))).toBe('transient');
  });
});
