// ════════════════════════════════════════
// Google API Client — Native REST with auto-refresh
// All Google API calls go through here. No CLI dependency.
// Mirrors the Microsoft client.ts pattern.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getValidAccessTokenForAccount } from './auth.js';
import { getGoogleAccount } from './accounts.js';
import { logGoogleActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';
import { recordAtDoor, inOutboundScope } from '../agent/v2/outbound.js';

const logger = createLogger('google-client');

const BASE_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling

// Scale fetch timeout with body size so multi-MB uploads (e.g. gmail_send
// with attachments, drive_upload multipart bodies) don't get killed by the
// default 30s ceiling. 30s baseline plus 30s per MB; capped at 5 min.
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
  // The account whose token to use. 'agent'/'user' are the ids of the
  // position-1 rows, so callers that still pass a kind keep working; the
  // tool executors pass a specific resolved account id for multi-account.
  accountId: string = 'agent',
): Promise<GoogleApiResult> {
  const token = await getValidAccessTokenForAccount(accountId);

  if (!token) {
    const acc = getGoogleAccount(accountId);
    const label = acc?.email ? acc.email : (acc?.kind === 'user' ? "user's account" : "agent's account");
    return { ok: false, data: null, error: `Not authenticated with Google (${label}). Connect in Settings > Google.`, apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
  }

  // Body handling — keep raw binary intact for multipart uploads.
  // Pre-2026-04-30 this branched only on string-vs-other, JSON.stringify()-ing
  // any Buffer or Uint8Array passed in. drive_upload's multipart body got
  // mangled into a JSON object string, Google rejected with 400, and the
  // caller pre-emptively base64-encoded its body to dodge that — which made
  // things worse (multipart/related with a base64 string body always 400s).
  // Now: strings pass through, Buffer/Uint8Array pass through as binary,
  // everything else gets JSON.stringify'd as before.
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

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: fetchBody as RequestInit['body'],
      signal: AbortSignal.timeout(timeoutForBody(fetchBody)),
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

    // Content-aware parse. Most Google endpoints return JSON, but alt=media
    // downloads (drive_read of a plain-text/markdown/binary file) return the
    // raw file bytes. Blindly calling resp.json() on those throws
    // "Unexpected token ... is not valid JSON" and fails the read on every
    // non-JSON file. Parse JSON only when the server says it's JSON; hand
    // everything else back as a string. GoogleApiResult.data is unknown and
    // downstream callers (e.g. drive_read) already branch on typeof data.
    const responseContentType = resp.headers.get('content-type') ?? '';
    const data = responseContentType.includes('application/json')
      ? await resp.json()
      : await resp.text();
    return { ok: true, data, apiEndpoint: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Google API call failed', { method, url, error: msg });
    return { ok: false, data: null, error: msg, apiEndpoint: url };
  }
}

// ── Public API ──

export function googleRead(
  url: string,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  accountId: string = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch('GET', url, undefined, undefined, accountId).then(result => {
    logGoogleActivity({
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
  return googleFetch(method, url, body, contentType, accountId).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify({ ...details, account: accountId }),
      gwsCommand: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    broadcast({
      type: 'google:activity',
      data: { agentId, agentName, action, actionType: 'write', details: { ...details, account: accountId } },
    });

    // PHASE-2 T5: THE DOOR RECORDS — but only for a send. This one function carries both
    // `gmail_send/reply/forward` (a person receives something) and calendar/drive/docs/sheets
    // writes (nobody does), so the discriminator is the OUTBOUND SCOPE the send tool opened.
    // A data write is outside any scope and correctly produces no delivery row; inventing a
    // per-action allow-list here would be a second registry drifting against the first.
    if (inOutboundScope()) {
      recordAtDoor({
        outcome: result.ok ? 'delivered' : 'failed',
        channel: 'email',
        tool: 'google-door',
        provider: 'gmail',
        detail: result.ok ? action : (result.error ?? 'google write failed'),
      });
    }

    return result;
  });
}

/**
 * v2.5.5 — Internal Google API call that does NOT log to the activity feed.
 * Use for plumbing/lookup calls that are part of a higher-level user-visible
 * action (e.g. forms_add_*_question internally calls forms.get to find the
 * append index — that lookup shouldn't show up as a separate activity row).
 *
 * The user-visible parent call still logs through googleRead/googleWrite.
 */
export function googleSilentFetch(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  contentType?: string,
  accountId: string = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType, accountId);
}
