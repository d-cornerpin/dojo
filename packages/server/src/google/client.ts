// ════════════════════════════════════════
// Google API Client — Native REST with auto-refresh
// All Google API calls go through here. No CLI dependency.
// Mirrors the Microsoft client.ts pattern.
// ════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getValidAccessToken } from './auth.js';
import { logGoogleActivity } from './activity-log.js';
import { broadcast } from '../gateway/ws.js';

const logger = createLogger('google-client');

const TIMEOUT_MS = 30_000;

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
): Promise<GoogleApiResult> {
  const token = await getValidAccessToken();

  if (!token) {
    return { ok: false, data: null, error: 'Not authenticated with Google. Connect in Settings > Google.', apiEndpoint: url };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  if (contentType) {
    headers['Content-Type'] = contentType;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
): Promise<GoogleApiResult> {
  return googleFetch('GET', url).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'read',
      details: JSON.stringify(details),
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
): Promise<GoogleApiResult> {
  return googleFetch(method, url, body, contentType).then(result => {
    logGoogleActivity({
      agentId, agentName, action, actionType: 'write',
      details: JSON.stringify(details),
      gwsCommand: result.apiEndpoint,
      success: result.ok,
      error: result.error,
    });

    broadcast({
      type: 'google:activity',
      data: { agentId, agentName, action, actionType: 'write', details },
    } as never);

    return result;
  });
}
