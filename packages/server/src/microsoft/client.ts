// ════════════════════════════════════════
// Microsoft Graph API Client
// All Graph API calls go through here for token refresh, logging, and error handling
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getValidAccessTokenForAccount } from './auth.js';
import { getMicrosoftAccount } from './accounts.js';
import { logMicrosoftActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';
import { recordAtDoor, inOutboundScope, recordedId } from '../agent/v2/outbound.js';

const logger = createLogger('ms-client');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 30_000;

/**
 * Build the URL prefix for a calendar operation based on the calendar_id form.
 *
 *   undefined       → me/                          (default mailbox)
 *   "<uuid>"        → me/calendars/{id}/           (own + accepted shares)
 *   "user@x.com"    → users/{email}/calendar/      (delegate access via Calendars.ReadWrite.Shared)
 *
 * Returns the prefix WITHOUT a trailing path segment — caller appends
 * 'events', 'calendarView?...', 'events/{id}', etc.
 */
export function calendarPrefix(calendarId: string | undefined): string {
  if (!calendarId) return 'me/';
  if (calendarId.includes('@')) return `users/${encodeURIComponent(calendarId)}/calendar/`;
  return `me/calendars/${encodeURIComponent(calendarId)}/`;
}

/**
 * Build the URL prefix for an OneDrive/SharePoint drive operation.
 *
 *   undefined       → me/drive/                   (personal OneDrive)
 *   "<drive-id>"    → drives/{driveId}/           (shared OneDrive item, or a SharePoint document library by its drive ID)
 *
 * Caller appends 'items/{id}', 'root/children', 'root:/path', etc.
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
  // The account whose token to use. 'agent'/'user' are the ids of the
  // position-1 rows, so callers passing a kind keep working; tool executors
  // pass a specific resolved account id for multi-account.
  accountId: string = 'agent',
): Promise<MsGraphResult> {
  const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE}/${endpoint}`;
  const token = await getValidAccessTokenForAccount(accountId);

  if (!token) {
    const acc = getMicrosoftAccount(accountId);
    const label = acc?.email ? acc.email : (acc?.kind === 'user' ? "user's account" : "agent's account");
    return { ok: false, data: null, error: `Not authenticated with Microsoft (${label}). Connect in Settings > Microsoft.`, apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    // v2.7.26 — force calendar event times to UTC in the response.
    //
    // Without this header, Microsoft Graph returns event start/end times
    // in the event's ORIGINAL timezone. Events created via Outlook desktop
    // get stored with the Windows timezone NAME ("Pacific Standard Time",
    // "Eastern Standard Time", etc.) rather than the IANA name. Node's
    // Intl.DateTimeFormat only accepts IANA names — it throws RangeError
    // on Windows names — which caused recurring events in the agenda
    // tools to surface as "(invalid time: Invalid Date)" because the
    // parser hit the unrecognized timezone string.
    //
    // With Prefer: outlook.timezone="UTC", Graph normalizes every event's
    // start/end to UTC + sets timeZone to "UTC" on the response. The
    // existing parseFlexibleTime + formatTimeRangeForAgent path then
    // handles them correctly, and the agent's user_timezone arg shapes
    // the human-facing display string.
    //
    // The header is only honored by calendar endpoints; non-calendar
    // Graph endpoints ignore it. Safe to set globally.
    Prefer: 'outlook.timezone="UTC"',
  };

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      let errorMsg: string;
      try {
        const errBody = await resp.json() as { error?: { code?: string; message?: string } };
        errorMsg = errBody?.error?.message ?? `HTTP ${resp.status}`;

        // Teams-specific: detect MSA limitation
        if (resp.status === 403 && errBody?.error?.code === 'Forbidden') {
          errorMsg = 'Access denied. If this is a Teams operation, Teams requires a Microsoft work/school account (Entra ID). Personal Microsoft accounts (outlook.com, hotmail.com, live.com) do not support Teams.';
        }
      } catch {
        errorMsg = `HTTP ${resp.status}`;
      }
      return { ok: false, data: null, error: errorMsg, apiEndpoint: url };
    }

    // Some endpoints return 202 Accepted or 204 No Content (no body)
    if (resp.status === 202 || resp.status === 204) {
      return { ok: true, data: null, apiEndpoint: url };
    }

    // Content-aware parse. Most Graph endpoints return JSON, but raw content
    // downloads (a file's /content) return the raw bytes. Blindly calling
    // resp.json() on those throws "Unexpected token ... is not valid JSON".
    // Parse JSON only when the server says it's JSON; hand everything else
    // back as a string. MsGraphResult.data is unknown and callers branch on
    // typeof data.
    const responseContentType = resp.headers.get('content-type') ?? '';
    const data = responseContentType.includes('application/json')
      ? await resp.json()
      : await resp.text();
    return { ok: true, data, apiEndpoint: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Microsoft Graph API call failed', { method, endpoint: url, error: msg });
    return { ok: false, data: null, error: msg, apiEndpoint: url };
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
  return graphFetch('GET', endpoint, undefined, accountId).then(result => {
    logMicrosoftActivity({
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
  return graphFetch(method, endpoint, body, accountId).then(result => {
    logMicrosoftActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify({ ...details, account: accountId }),
      apiEndpoint: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    // Broadcast write actions to dashboard
    broadcast({
      type: 'microsoft:activity',
      data: { agentId, agentName, action, actionType: 'write', details: { ...details, account: accountId } },
    });

    // PHASE-2 T5: THE DOOR RECORDS — but only for a send. Same reasoning as the Google door:
    // this one function carries `outlook_send/reply/forward` and `teams_send_*` (a person
    // receives something) alongside calendar and file writes (nobody does), and the OUTBOUND
    // SCOPE the send tool opened is what tells them apart. The scope also names the CHANNEL,
    // so a Teams send is recorded as Teams and an Outlook send as email.
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
