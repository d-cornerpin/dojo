// ════════════════════════════════════════
// Microsoft Graph API Client
// All Graph API calls go through here for token refresh, logging, and error handling
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getValidAccessToken } from './auth.js';
import { logMicrosoftActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('ms-client');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 30_000;

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
): Promise<MsGraphResult> {
  const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE}/${endpoint}`;
  const token = await getValidAccessToken();

  if (!token) {
    return { ok: false, data: null, error: 'Not authenticated with Microsoft', apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
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

    const data = await resp.json();
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
): Promise<MsGraphResult> {
  return graphFetch('GET', endpoint).then(result => {
    logMicrosoftActivity({
      agentId, agentName, action, actionType: 'read',
      details: JSON.stringify(details),
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
): Promise<MsGraphResult> {
  return graphFetch(method, endpoint, body).then(result => {
    logMicrosoftActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify(details),
      apiEndpoint: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    // Broadcast write actions to dashboard
    broadcast({
      type: 'microsoft:activity',
      data: { agentId, agentName, action, actionType: 'write', details },
    } as never);

    return result;
  });
}
