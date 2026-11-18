// Microsoft Graph API client: msGraphRead/msGraphWrite add token refresh, logging and error handling.
// Byte calls that must not log use graph-fetch.ts (re-exported here as graphFetch).

import { createLogger } from '../logger.js';
import { openAgentCall, STOPPED_BY_USER } from '../agent/abortable-call.js';
import { getValidAccessTokenForAccount } from './auth.js';
import { getMicrosoftAccount } from './accounts.js';
import { logMicrosoftActivity } from './activity-log.js';
import { recordAtDoor, inOutboundScope, recordedId } from '../agent/v2/outbound.js';

const logger = createLogger('ms-client');

export { graphFetch } from './graph-fetch.js';   // the un-wrapped Graph door
import { GRAPH_BASE } from './graph-fetch.js';
// The Graph deadline scales with the body, in the same shape as google/client.ts timeoutForBody: 30s
// plus 30s per MB, capped at 5 minutes, so a multi-MB sendMail can upload. A bodyless call keeps 30s.
const TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling

/** Same shape as `google/client.ts` timeoutForBody, so the two clients answer the same way. */
function graphTimeoutForBody(body: unknown): number {
  if (body === undefined || body === null) return TIMEOUT_MS;
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  if (!serialized) return TIMEOUT_MS;
  const scaled = TIMEOUT_MS + Math.ceil(serialized.length / (1024 * 1024)) * 30_000;
  return Math.min(scaled, MAX_TIMEOUT_MS);
}

/**
 * URL prefix for a calendar operation from the calendar_id form: undefined is me/ (default mailbox),
 * "<uuid>" is me/calendars/{id}/ (own and accepted shares), "user@example.com" is users/{email}/calendar/
 * (delegate access via Calendars.ReadWrite.Shared). The caller appends 'events' and the like.
 */
export function calendarPrefix(calendarId: string | undefined): string {
  if (!calendarId) return 'me/';
  if (calendarId.includes('@')) return `users/${encodeURIComponent(calendarId)}/calendar/`;
  return `me/calendars/${encodeURIComponent(calendarId)}/`;
}

/**
 * URL prefix for a drive operation: undefined is me/drive/ (personal OneDrive), "<drive-id>" is
 * drives/{driveId}/ (a shared item or a SharePoint library). The caller appends 'items/{id}' and the like.
 */
export function drivePrefix(driveId: string | undefined): string {
  if (!driveId) return 'me/drive/';
  return `drives/${encodeURIComponent(driveId)}/`;
}

export interface MsGraphResult {
  ok: boolean;
  data: unknown;
  error?: string;
  apiEndpoint: string;
}

async function graphFetch(
  method: string,
  endpoint: string,
  body?: unknown,
  // Account whose token to use: 'agent'/'user' name the position-1 rows; tools pass a resolved account id.
  accountId: string = 'agent',
  // Whose stop this call answers to. Optional and last; a call without one is platform plumbing with
  // no agent to stop it.
  agentId?: string,
): Promise<MsGraphResult> {
  const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE}/${endpoint}`;
  const token = await getValidAccessTokenForAccount(accountId);

  if (!token) {
    const acc = getMicrosoftAccount(accountId);
    const label = acc?.email ? acc.email : (acc?.kind === 'user' ? "user's account" : "agent's account");
    return { ok: false, data: null, error: `Not authenticated with Microsoft (${label}). Connect in Settings → Channels (the Microsoft cards).`, apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    // Force calendar times to UTC: Graph otherwise returns the event's original zone, and Outlook-desktop
    // events carry Windows zone names that Intl.DateTimeFormat rejects. Non-calendar endpoints ignore it.
    Prefer: 'outlook.timezone="UTC"',
  };

  // Composed with the turn scope so the deadline still fires; sized from this call's body.
  const graphTimeoutMs = graphTimeoutForBody(body);
  const slot = agentId === undefined
    ? null
    : openAgentCall(agentId, 'turn', AbortSignal.timeout(graphTimeoutMs));
  if (slot?.refused) {
    slot.release();
    return { ok: false, data: null, error: STOPPED_BY_USER, apiEndpoint: url };
  }
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: slot?.signal ?? AbortSignal.timeout(graphTimeoutMs),
    });

    if (!resp.ok) {
      let errorMsg: string;
      try {
        const errBody = await resp.json() as { error?: { code?: string; message?: string } };
        errorMsg = errBody?.error?.message ?? `HTTP ${resp.status}`;

        // A 403 'Forbidden' states the fact plainly; the Teams remedy lives in tools/error-remedies.ts.
        if (resp.status === 403 && errBody?.error?.code === 'Forbidden') {
          errorMsg = 'Access denied (HTTP 403 Forbidden).';
        }
      } catch {
        errorMsg = `HTTP ${resp.status}`;
      }
      return { ok: false, data: null, error: errorMsg, apiEndpoint: url };
    }

    if (resp.status === 202 || resp.status === 204) {
      return { ok: true, data: null, apiEndpoint: url };
    }

    // Parse JSON only when the server says it is JSON; raw downloads (a file's /content) come back as a
    // string. MsGraphResult.data is unknown and callers branch on typeof data.
    const responseContentType = resp.headers.get('content-type') ?? '';
    const data = responseContentType.includes('application/json')
      ? await resp.json()
      : await resp.text();
    return { ok: true, data, apiEndpoint: url };
  } catch (err) {
    // The stop is named before the transport calls it a failure, off this call's own controller.
    if (slot?.cutByStop()) {
      return { ok: false, data: null, error: STOPPED_BY_USER, apiEndpoint: url };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Microsoft Graph API call failed', { method, endpoint: url, error: msg });
    return { ok: false, data: null, error: msg, apiEndpoint: url };
  } finally {
    slot?.release();
  }
}

// ── Public API ──

export function msGraphRead(
  endpoint: string,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  accountId: string = 'agent',
): Promise<MsGraphResult> {
  return graphFetch('GET', endpoint, undefined, accountId, agentId).then(result => {
    // A watcher's own poll ('system') is not logged: only reads made for an agent are activity.
    if (agentId !== 'system') logMicrosoftActivity({
      agentId, agentName, action, actionType: 'read',
      details: JSON.stringify({ ...details, account: accountId }),
      apiEndpoint: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });
    return result;
  });
}

export function msGraphWrite(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  endpoint: string,
  body: unknown | undefined,
  agentId: string,
  agentName: string,
  action: string,
  details: Record<string, unknown>,
  accountId: string = 'agent',
): Promise<MsGraphResult> {
  return graphFetch(method, endpoint, body, accountId, agentId).then(result => {
    logMicrosoftActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify({ ...details, account: accountId }),
      apiEndpoint: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    // Only a send is recorded at the door: the outbound scope the send tool opened separates sends (a
    // person receives something) from calendar and file writes (nobody does).
    if (inOutboundScope()) {
      recordedId(recordAtDoor({
        outcome: result.ok ? 'delivered' : 'failed',
        channel: 'email',
        tool: 'msgraph-door',
        provider: 'outlook',
        detail: result.ok ? action : (result.error ?? 'graph write failed'),
      }), 'outlook: door crossing', { action });
    }

    return result;
  });
}
