// ════════════════════════════════════════
// Google Workspace Auth — Native OAuth 2.0
// No gws CLI dependency. Direct REST API with auto-refresh.
// Mirrors the Microsoft auth.ts pattern.
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';

const logger = createLogger('google-auth');

// ── Hardcoded OAuth client — registered once by Cornerpin ──
const CLIENT_ID = '910593387780-tasrtdi6f1r4dktt7arg9bqfeq89vvrj.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
].join(' ');

export interface GoogleWorkspaceConfig {
  enabled: boolean;
  connected: boolean;
  accountEmail: string | null;
  enabledServices: {
    gmail: boolean;
    calendar: boolean;
    drive: boolean;
    docs: boolean;
    sheets: boolean;
    slides: boolean;
  };
  lastVerifiedAt: string | null;
}

const DEFAULT_SERVICES = {
  gmail: true,
  calendar: true,
  drive: true,
  docs: true,
  sheets: true,
  slides: true,
};

// ── Config Helpers ──

function getConfigValue(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function setConfigValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

function deleteConfigValue(key: string): void {
  try { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); } catch { /* best effort */ }
}

// ── Config Getters ──

export function getGoogleWorkspaceConfig(): GoogleWorkspaceConfig {
  const servicesRaw = getConfigValue('gws_enabled_services');
  let services = { ...DEFAULT_SERVICES };
  if (servicesRaw) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(servicesRaw) }; } catch { /* defaults */ }
  }

  return {
    enabled: getConfigValue('gws_enabled') === 'true',
    connected: getConfigValue('gws_connected') === 'true',
    accountEmail: getConfigValue('gws_account_email'),
    enabledServices: services,
    lastVerifiedAt: getConfigValue('gws_last_verified_at'),
  };
}

export function isGoogleEnabled(): boolean {
  return getConfigValue('gws_enabled') === 'true';
}

export function isGoogleConnected(): boolean {
  return getConfigValue('gws_connected') === 'true';
}

export function getEnabledServices(): GoogleWorkspaceConfig['enabledServices'] {
  return getGoogleWorkspaceConfig().enabledServices;
}

// ── Config Setters ──

export function setGoogleEnabled(enabled: boolean): void {
  setConfigValue('gws_enabled', String(enabled));
}

export function setGoogleConnected(connected: boolean, email?: string): void {
  setConfigValue('gws_connected', String(connected));
  if (email) {
    setConfigValue('gws_account_email', email);
  }
  if (connected) {
    setConfigValue('gws_last_verified_at', new Date().toISOString());
    broadcast({ type: 'google:connected', data: { email: email ?? '' } } as never);
  } else {
    broadcast({ type: 'google:disconnected' } as never);
  }
}

export function setEnabledServices(services: Partial<GoogleWorkspaceConfig['enabledServices']>): void {
  const current = getEnabledServices();
  setConfigValue('gws_enabled_services', JSON.stringify({ ...current, ...services }));
}

// ── Token Management ──

function getAccessToken(): string | null { return getConfigValue('gws_access_token'); }
function getRefreshToken(): string | null { return getConfigValue('gws_refresh_token'); }
function getTokenExpiresAt(): number { const v = getConfigValue('gws_token_expires_at'); return v ? parseInt(v, 10) : 0; }

function storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): void {
  setConfigValue('gws_access_token', accessToken);
  if (refreshToken) setConfigValue('gws_refresh_token', refreshToken);
  setConfigValue('gws_token_expires_at', String(Date.now() + expiresIn * 1000));
}

// Mutex to prevent concurrent refresh
let refreshPromise: Promise<string | null> | null = null;

export async function getValidAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  const expiresAt = getTokenExpiresAt();
  // Return current token if valid with 5-minute buffer
  if (token && Date.now() < expiresAt - 5 * 60 * 1000) return token;
  // Deduplicate concurrent refresh calls
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    logger.warn('No Google refresh token available');
    return null;
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error('Google token refresh failed', { status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        setGoogleConnected(false);
        try { sendAlert('Google Workspace connection expired. Re-authenticate in Settings > Google.', 'warning'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
    storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in);
    logger.debug('Google access token refreshed');
    return data.access_token;
  } catch (err) {
    logger.error('Google token refresh error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── OAuth Flow ──

// Store state + redirect URI for the callback
let storedState: string | null = null;
let storedRedirectUri: string | null = null;

export function getStoredState(): string | null { return storedState; }
export function getStoredRedirectUri(): string | null { return storedRedirectUri; }

export function buildAuthUrl(redirectUri: string): { authUrl: string } {
  const state = crypto.randomBytes(16).toString('hex');
  storedState = state;
  storedRedirectUri = redirectUri;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return { authUrl: `${AUTH_BASE}?${params.toString()}` };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Token exchange failed (${resp.status}): ${errText.slice(0, 300)}` };
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
    storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in);

    // Get email from userinfo
    let email = '';
    try {
      const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userResp.ok) {
        const user = await userResp.json() as { email?: string };
        email = user.email ?? '';
      }
    } catch {}

    setGoogleConnected(true, email);
    setGoogleEnabled(true);

    logger.info('Google Workspace connected', { email });
    return { success: true, email };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Auth Verification ──

export async function testGoogleAuth(): Promise<{ authenticated: boolean; email: string | null }> {
  const token = await getValidAccessToken();
  if (!token) return { authenticated: false, email: null };

  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { authenticated: false, email: null };
    const user = await resp.json() as { email?: string };
    setConfigValue('gws_last_verified_at', new Date().toISOString());
    return { authenticated: true, email: user.email ?? null };
  } catch {
    return { authenticated: false, email: null };
  }
}

export async function checkGoogleOnStartup(): Promise<void> {
  if (!isGoogleConnected()) return;
  const auth = await testGoogleAuth();
  if (auth.authenticated) {
    logger.info('Google Workspace auth verified', { email: auth.email });
  } else {
    logger.warn('Google Workspace auth expired, marking disconnected');
    setGoogleConnected(false);
  }
}

// ── Disconnect ──

export function disconnectGoogle(): void {
  for (const key of ['gws_enabled', 'gws_connected', 'gws_account_email', 'gws_access_token', 'gws_refresh_token', 'gws_token_expires_at', 'gws_last_verified_at', 'gws_enabled_services']) {
    deleteConfigValue(key);
  }
  broadcast({ type: 'google:disconnected' } as never);
  logger.info('Google Workspace disconnected');
}

// ── Access Level ──

export function getAgentGoogleAccessLevel(agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  if (!isGoogleEnabled() || !isGoogleConnected()) return 'none';
  if (isPM) return 'none';
  if (isPrimary) return 'full';
  return 'read';
}
