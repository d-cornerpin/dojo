// ════════════════════════════════════════════════════════════════════════════════════════
// GITHUB CONNECTS BY DEVICE FLOW — ONE SCOPE, NO SECRET, AND A CLOCK THAT ANSWERS TO GITHUB.
//
// ── WHY DEVICE FLOW, BEYOND OWNER DECISION D3 ──
// Google and Microsoft connect by REDIRECT, and the Settings page carries a standing warning
// because of it: OAuth only works from `localhost`, and over a Cloudflare tunnel the callback
// silently fails. Device flow has NO CALLBACK ROUTE AT ALL — nothing to add to
// `ALWAYS_PUBLIC_PATHS`, nothing that breaks when the box is reached through a tunnel. That is
// a real advantage of this shape, not a consolation for D3.
//
// ── THE SCOPE, PINNED: `public_repo`. ONE STRING. ──
// It is the narrowest scope a GitHub OAUTH APP offers that can create an issue on a public
// repository; there is no issues-only OAuth scope. The narrower GitHub-APP permission
// (`Issues: write` on one repository) was measured and REFUSED: a GitHub App's user-to-server
// token EXPIRES, and refreshing it requires the client SECRET — which D3 forbids shipping
// ("no secret in the build, nothing extractable"). An OAuth App's device-flow exchange needs
// no secret and its token does not expire. The client id is PUBLIC by design and lives in the
// `config` table, set once by the owner; there is no secret anywhere in this build to leak.
//
// ── THE CLOCK, AND WHY IT IS NOT OURS (NO-DOOMED-DIALS census row 39) ──
// Every wait here is a number GITHUB DECLARED. `/login/device/code` answers with `interval`
// (how often we may poll) and `expires_in` (how long the user's code lives); the `slow_down`
// error answers with a NEW `interval` and we obey it. Our two constants are a FLOOR and a
// CEILING that refuse an absurd server answer, and nothing else — that is P2 satisfied by
// DECLARATION, the same argument `providers.first_chunk_timeout_ms` makes on row 1.
//
// P3: when a bound trips, we FAIL HONESTLY TO THE HUMAN AND STOP. Expiry, denial, an error we
// have never seen, or an endpoint we cannot reach all END the loop and broadcast a sentence
// the card shows. Nothing re-dials, nothing auto-restarts, nothing retries in the background.
// A user pressing Connect again is a NEW HUMAN ACT and is the only restart there is.
//
// P1 is not engaged: this bounds a network handshake between two servers, never an agent's
// work, and no clock here judges whether anything is stuck.
//
// NO `net-guard`, the same call `google/`, `microsoft/`, `twilio/` and `update.ts` all make:
// that header says the address check exists for ATTACKER-INFLUENCEABLE URLs, and these three
// are fixed product constants no model, agent or user input reaches.
// ════════════════════════════════════════════════════════════════════════════════════════

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
/** Bound on ONE HTTP call. Not a retry budget — a call that trips this ends the flow. */
export const DEVICE_HTTP_TIMEOUT_MS = 10_000;

export interface DeviceFlowState {
  userCode: string; verificationUri: string; expiresAt: number; intervalMs: number;
}
export type DeviceFlowStart =
  | { ok: true; state: DeviceFlowState }
  | { ok: false; error: string };

const NOT_CONFIGURED = 'GitHub is not configured on this box yet.';

// ── The one flow in flight ──
// ONE at a time, held in a module variable keyed by its device code — the same in-memory
// flow-plus-lifetime shape `google/auth.ts` uses for its state parameter. A second Connect
// press cancels the first rather than racing it.

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
    // GitHub's own `expires_in`, honestly surfaced. Not a local kill: the code really is dead
    // on GitHub's side, and the only cure is a new one, which only the user can ask for.
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
      // P3: a call that failed is not re-dialled. It ends the flow and says so.
      fail(flow, `Could not reach GitHub (${err instanceof Error ? err.message : String(err)}). Press Connect to try again.`);
      return;
    }
    if (flow.cancelled || current !== flow) return;
    const verdict = verdictFor(body, intervalMs);
    if (verdict.kind === 'wait') { intervalMs = verdict.intervalMs; continue; }
    if (verdict.kind === 'stop') { fail(flow, verdict.message); return; }
    const login = await fetchLogin(verdict.accessToken);
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
  // BOTH numbers are GitHub's. Ours only refuse the absurd: a floor under the interval so a
  // zero cannot become a hot loop, a ceiling over the lifetime so a bad answer cannot park a
  // loop here for a week.
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

// What the CARD is told is not this module's job: the status unions the stored row with this
// live flow, so it lives in `github/status.ts`, which reads both and is imported by neither.
