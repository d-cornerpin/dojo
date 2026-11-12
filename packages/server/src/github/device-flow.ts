// Connects GitHub by device flow: no callback route (so it works through a tunnel) and no client secret.
// Scope is `public_repo`, the narrowest OAuth App scope that can open a public issue; a GitHub App token
// would expire and need the client secret to refresh.
// Every wait is a number GitHub declared (`interval`, `expires_in`, `slow_down`); our constants only bound them.
// Any stop (expiry, denial, unknown error, unreachable) ends the loop and tells the card; Connect restarts it.
// No `net-guard`: the three URLs are fixed constants that no model, agent or user input reaches.

import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { githubClientId, saveGithubAccount } from './account.js';

const logger = createLogger('github-device-flow');

export const GITHUB_OAUTH_SCOPE = 'public_repo';
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';

/** FLOOR on GitHub's declared `interval`. Refuses a server answer of 0 (a hot loop). */
export const DEVICE_POLL_MIN_INTERVAL_MS = 5_000;
/** CEILING on GitHub's declared `expires_in`. Refuses a server answer of a week. */
export const DEVICE_POLL_MAX_LIFETIME_MS = 900_000;
/** Bound on ONE HTTP call; a call that trips it ends the flow (no retry). */
export const DEVICE_HTTP_TIMEOUT_MS = 10_000;

export interface DeviceFlowState {
  userCode: string; verificationUri: string; expiresAt: number; intervalMs: number;
}
export type DeviceFlowStart =
  | { ok: true; state: DeviceFlowState }
  | { ok: false; error: string };

const NOT_CONFIGURED = 'GitHub is not configured on this box yet.';

// One flow at a time, keyed by its device code; a second Connect press cancels the first.

interface Flow { deviceCode: string; state: DeviceFlowState; cancelled: boolean }
let current: Flow | null = null;

export function deviceFlowInProgress(): DeviceFlowState | null {
  return current ? current.state : null;
}

export function cancelDeviceFlow(): void {
  if (!current) return;
  current.cancelled = true;
  current = null;
}

// ── The verdict: the whole polling contract, as a pure function ──

/** Pure. Given GitHub's token-endpoint body, say what the loop does next. */
export type PollVerdict =
  | { kind: 'granted'; accessToken: string; scope: string }
  | { kind: 'wait'; intervalMs: number }
  | { kind: 'stop'; reason: 'expired' | 'denied' | 'unknown'; message: string };

export function verdictFor(body: Record<string, unknown>, currentIntervalMs: number): PollVerdict {
  const token = typeof body.access_token === 'string' ? body.access_token : null;
  if (token) return { kind: 'granted', accessToken: token, scope: String(body.scope ?? '') };
  const err = typeof body.error === 'string' ? body.error : 'unknown';
  if (err === 'authorization_pending') return { kind: 'wait', intervalMs: currentIntervalMs };
  if (err === 'slow_down') {
    const declared = typeof body.interval === 'number' ? body.interval * 1000 : currentIntervalMs + 5_000;
    return { kind: 'wait', intervalMs: Math.max(DEVICE_POLL_MIN_INTERVAL_MS, declared) };
  }
  if (err === 'expired_token') {
    return { kind: 'stop', reason: 'expired',
      message: 'That sign-in code expired. Press Connect to get a new one.' };
  }
  if (err === 'access_denied') {
    return { kind: 'stop', reason: 'denied',
      message: 'Sign-in was cancelled on GitHub. Nothing was connected.' };
  }
  return { kind: 'stop', reason: 'unknown',
    message: `GitHub refused the sign-in (${err}). Nothing was connected.` };
}

// ── The wire ──

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(DEVICE_HTTP_TIMEOUT_MS),
  });
  return await res.json() as Record<string, unknown>;
}

/** The login is a nicety, not the connection. A failure here loses a NAME, never the grant. */
async function fetchLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_USER_URL, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DEVICE_HTTP_TIMEOUT_MS),
    });
    const body = await res.json() as Record<string, unknown>;
    return typeof body.login === 'string' ? body.login : null;
  } catch (err) {
    logger.warn('GitHub granted a token but would not name the user', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function fail(flow: Flow, error: string): void {
  if (current === flow) current = null;
  flow.cancelled = true;
  logger.warn('GitHub device flow ended without a connection', { error });
  broadcast({ type: 'github:connect_failed', error });
}

// ── The loop ──

async function pollUntilAnswered(flow: Flow): Promise<void> {
  let intervalMs = flow.state.intervalMs;
  const clientId = githubClientId();
  if (!clientId) { fail(flow, NOT_CONFIGURED); return; }
  for (;;) {
    await sleep(intervalMs);
    if (flow.cancelled || current !== flow) return;
    // GitHub's own `expires_in`: the code is dead on GitHub's side, so only a new Connect helps.
    if (Date.now() >= flow.state.expiresAt) {
      fail(flow, 'That sign-in code expired. Press Connect to get a new one.');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await postForm(GITHUB_TOKEN_URL, {
        client_id: clientId,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch (err) {
      // A failed call is not re-dialled: it ends the flow and says so.
      fail(flow, `Could not reach GitHub (${err instanceof Error ? err.message : String(err)}). Press Connect to try again.`);
      return;
    }
    if (flow.cancelled || current !== flow) return;
    const verdict = verdictFor(body, intervalMs);
    if (verdict.kind === 'wait') { intervalMs = verdict.intervalMs; continue; }
    if (verdict.kind === 'stop') { fail(flow, verdict.message); return; }
    const login = await fetchLogin(verdict.accessToken);
    // The owner may have cancelled, or pressed Connect again, while the name lookup was out.
    if (flow.cancelled || current !== flow) return;
    saveGithubAccount(login, verdict.accessToken, verdict.scope);
    if (current === flow) current = null;
    logger.info('GitHub connected', { login, scope: verdict.scope });
    broadcast({ type: 'github:connected', login });
    return;
  }
}

export async function startDeviceFlow(): Promise<DeviceFlowStart> {
  const clientId = githubClientId();
  if (!clientId) return { ok: false, error: NOT_CONFIGURED };
  cancelDeviceFlow();
  let body: Record<string, unknown>;
  try {
    body = await postForm(GITHUB_DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_OAUTH_SCOPE });
  } catch (err) {
    return { ok: false, error: `Could not reach GitHub (${err instanceof Error ? err.message : String(err)}).` };
  }
  const deviceCode = typeof body.device_code === 'string' ? body.device_code : null;
  const userCode = typeof body.user_code === 'string' ? body.user_code : null;
  if (!deviceCode || !userCode) {
    return { ok: false, error: `GitHub did not start a sign-in (${String(body.error ?? 'no device code')}).` };
  }
  // Both numbers are GitHub's; ours only floor the interval (no hot loop) and cap the lifetime.
  const state: DeviceFlowState = {
    userCode,
    verificationUri: typeof body.verification_uri === 'string'
      ? body.verification_uri : 'https://github.com/login/device',
    intervalMs: Math.max(DEVICE_POLL_MIN_INTERVAL_MS,
      typeof body.interval === 'number' ? body.interval * 1000 : 0),
    expiresAt: Date.now() + Math.min(DEVICE_POLL_MAX_LIFETIME_MS,
      typeof body.expires_in === 'number' ? body.expires_in * 1000 : DEVICE_POLL_MAX_LIFETIME_MS),
  };
  const flow: Flow = { deviceCode, state, cancelled: false };
  current = flow;
  broadcast({ type: 'github:device_code', userCode, verificationUri: state.verificationUri, expiresAt: state.expiresAt });
  void pollUntilAnswered(flow).catch((err: unknown) => {
    fail(flow, `The GitHub sign-in stopped unexpectedly (${err instanceof Error ? err.message : String(err)}).`);
  });
  return { ok: true, state };
}

// The card's status unions the stored row with this flow in `github/status.ts`, which imports both and is
// imported by neither.
