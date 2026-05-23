// ════════════════════════════════════════
// Google API Client — Native REST with auto-refresh
// All Google API calls go through here. No CLI dependency.
// Mirrors the Microsoft client.ts pattern.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getValidAccessToken, type AccountSlot } from './auth.js';
import { logGoogleActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';

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
  slot: AccountSlot = 'agent',
): Promise<GoogleApiResult> {
  const token = await getValidAccessToken(slot);

  if (!token) {
    const slotLabel = slot === 'user' ? "user's" : "agent's";
    return { ok: false, data: null, error: `Not authenticated with Google (${slotLabel} account). Connect in Settings > Google.`, apiEndpoint: url };
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

    const data = await resp.json();
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
  slot: AccountSlot = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch('GET', url, undefined, undefined, slot).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'read',
      details: JSON.stringify({ ...details, slot }),
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
  slot: AccountSlot = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType, slot).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify({ ...details, slot }),
      gwsCommand: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    broadcast({
      type: 'google:activity',
      data: { agentId, agentName, action, actionType: 'write', details: { ...details, slot } },
    } as never);

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
  slot: AccountSlot = 'agent',
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType, slot);
}
