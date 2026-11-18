// Google API client: native REST with auto-refresh. All Google API calls go through here.

import { createLogger } from '../logger.js';
import { openAgentCall, STOPPED_BY_USER } from '../agent/abortable-call.js';
import { getValidAccessTokenForAccount } from './auth.js';
import { getGoogleAccount } from './accounts.js';
import { logGoogleActivity } from './activity-log.js';
import { recordAtDoor, inOutboundScope, recordedId } from '../agent/v2/outbound.js';

const logger = createLogger('google-client');

const BASE_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling

// Fetch timeout scales with body size (30s plus 30s per MB, capped at 5 min) so big uploads are not killed.
function timeoutForBody(body: string | Uint8Array | undefined): number {
  if (!body) return BASE_TIMEOUT_MS;
  const size = typeof body === 'string' ? body.length : body.byteLength;
  const scaled = BASE_TIMEOUT_MS + Math.ceil(size / (1024 * 1024)) * 30_000;
  return Math.min(scaled, MAX_TIMEOUT_MS);
}

export interface GoogleApiResult {
  ok: boolean;
  data: unknown;
  error?: string;
  apiEndpoint: string;
}

async function googleFetch(
  method: string,
  url: string,
  body?: unknown,
  contentType?: string,
  // The account whose token to use: 'agent'/'user' are the position-1 row ids, and multi-account tool
  // executors pass a specific resolved account id.
  accountId: string = 'agent',
  // Whose stop this call answers to. Optional and last so every call site compiles; the public wrappers
  // (the only doors an agent's tool reaches this through) pass it. No agentId means platform plumbing
  // (token refresh, boot probe) with no agent to be stopped by.
  agentId?: string,
): Promise<GoogleApiResult> {
  const token = await getValidAccessTokenForAccount(accountId);

  if (!token) {
    const acc = getGoogleAccount(accountId);
    const label = acc?.email ? acc.email : (acc?.kind === 'user' ? "user's account" : "agent's account");
    return { ok: false, data: null, error: `Not authenticated with Google (${label}). Connect in Settings → Channels (the Google cards).`, apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
  }

  // Keep raw binary intact for multipart uploads: strings and Buffer/Uint8Array pass through as they
  // are (JSON.stringify or base64 of a multipart/related body makes Google answer 400); anything else
  // is JSON.stringify'd.
  let fetchBody: string | Uint8Array | undefined;
  if (body === undefined || body === null) {
    fetchBody = undefined;
  } else if (typeof body === 'string') {
    fetchBody = body;
  } else if (body instanceof Uint8Array) {
    // Covers both Node Buffer (subclass of Uint8Array) and plain Uint8Array.
    fetchBody = body;
  } else {
    fetchBody = JSON.stringify(body);
  }

  // The caller's own clock is COMPOSED with this agent's stop, never replaced: a slow upload still times out
  // as an upload. Scope 'turn': a tool executor holds the turn open on this call.
  const slot = agentId === undefined
    ? null
    : openAgentCall(agentId, 'turn', AbortSignal.timeout(timeoutForBody(fetchBody)));
  if (slot?.refused) {
    slot.release();
    return { ok: false, data: null, error: STOPPED_BY_USER, apiEndpoint: url };
  }
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: fetchBody as RequestInit['body'],
      signal: slot?.signal ?? AbortSignal.timeout(timeoutForBody(fetchBody)),
    });

    if (!resp.ok) {
      let errorMsg: string;
      try {
        const errBody = await resp.json() as { error?: { code?: number; message?: string; status?: string } };
        errorMsg = errBody?.error?.message ?? `HTTP ${resp.status}`;
      } catch {
        errorMsg = `HTTP ${resp.status}`;
      }
      return { ok: false, data: null, error: errorMsg, apiEndpoint: url };
    }

    // Some endpoints return 204 No Content
    if (resp.status === 204) {
      return { ok: true, data: null, apiEndpoint: url };
    }

    // Parse JSON only when the server says it is JSON: alt=media downloads return raw file bytes and
    // resp.json() would throw. Everything else is handed back as a string (callers branch on typeof data).
    const responseContentType = resp.headers.get('content-type') ?? '';
    const data = responseContentType.includes('application/json')
      ? await resp.json()
      : await resp.text();
    return { ok: true, data, apiEndpoint: url };
  } catch (err) {
    // A stop is named as a stop before the transport calls it a failure. Read off this call's OWN
    // controller, so the composed deadline can never answer yes.
    if (slot?.cutByStop()) {
      return { ok: false, data: null, error: STOPPED_BY_USER, apiEndpoint: url };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Google API call failed', { method, url, error: msg });
    return { ok: false, data: null, error: msg, apiEndpoint: url };
  } finally {
    slot?.release();
  }
}


export function googleRead(
  url: string,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  accountId: string = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch('GET', url, undefined, undefined, accountId, agentId).then(result => {
    // A watcher's own poll ('system') is not logged: only reads made for an agent are activity.
    if (agentId !== 'system') logGoogleActivity({
      agentId, agentName, action, actionType: 'read',
      details: JSON.stringify({ ...details, account: accountId }),
      gwsCommand: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });
    return result;
  });
}

export function googleWrite(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body: unknown | undefined,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  contentType?: string,
  accountId: string = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType, accountId, agentId).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify({ ...details, account: accountId }),
      gwsCommand: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    // The door records only a send. This one function carries gmail_send/reply/forward (a person
    // receives something) and data writes (nobody does), so the discriminator is the outbound scope the
    // send tool opened; a per-action allow-list here would be a second registry drifting against it.
    if (inOutboundScope()) {
      recordedId(recordAtDoor({
        outcome: result.ok ? 'delivered' : 'failed',
        channel: 'email',
        tool: 'google-door',
        provider: 'gmail',
        detail: result.ok ? action : (result.error ?? 'google write failed'),
      }), 'gmail: door crossing', { action });
    }

    return result;
  });
}

/**
 * Internal Google API call that does NOT log to the activity feed, for lookups that are part of a
 * higher-level call (e.g. forms.get to find an append index); the parent call still logs.
 */
export function googleSilentFetch(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  contentType?: string,
  accountId: string = 'agent',
  // A silent call is still an agent's call: hidden from the activity feed (a noise decision), but
  // its stop must still reach it. Optional because some plumbing callers have no agent.
  agentId?: string,
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType, accountId, agentId);
}
