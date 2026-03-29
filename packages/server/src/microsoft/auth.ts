// ════════════════════════════════════════
// Microsoft 365 Auth — OAuth 2.0 Authorization Code Flow
// Handles both MSA (personal) and Entra (work/school) accounts
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';

const logger = createLogger('ms-auth');

// MSA tenant ID — used to detect personal vs work/school accounts
const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function getAuthBase(): string {
  const accountType = getConfigValue('ms_account_type');
  if (accountType === 'msa') {
    return 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
  }
  // Work/school — use tenant ID if available, otherwise fall back to organizations
  const tenantId = getConfigValue('ms_tenant_id');
  if (tenantId) {
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;
  }
  return 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
}

const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'User.Read',
  'Mail.Read', 'Mail.Send', 'Mail.ReadWrite',
  'Calendars.Read', 'Calendars.ReadWrite',
  'Files.Read', 'Files.ReadWrite.All',
  'Chat.Read', 'Chat.ReadWrite',
  'Notes.ReadWrite',            // OneNote
  'Tasks.ReadWrite',            // Microsoft To Do / Planner
  'Contacts.ReadWrite',         // Outlook contacts
  // Note: Sites.ReadWrite.All, ChannelMessage.Send, Team.ReadBasic.All,
  // Channel.ReadBasic.All removed — they require admin consent on most
  // Entra tenants and block non-admin users from signing in.
].join(' ');

export interface MicrosoftWorkspaceConfig {
  enabled: boolean;
  connected: boolean;
  accountEmail: string | null;
  accountType: 'msa' | 'entra' | null;
  enabledServices: {
    outlook: boolean;
    calendar: boolean;
    onedrive: boolean;
    teams: boolean;
  };
  lastVerifiedAt: string | null;
}

const DEFAULT_SERVICES = {
  outlook: true,
  calendar: true,
  onedrive: true,
  teams: true,
};

// ── Config Helpers ──

function getConfigValue(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}

function setConfigValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}

function deleteConfigValue(key: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM config WHERE key = ?').run(key);
  } catch { /* best effort */ }
}

// ── Config Getters ──

export function getMicrosoftWorkspaceConfig(): MicrosoftWorkspaceConfig {
  const servicesRaw = getConfigValue('ms_enabled_services');
  let services = { ...DEFAULT_SERVICES };
  if (servicesRaw) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(servicesRaw) }; } catch { /* defaults */ }
  }

  return {
    enabled: getConfigValue('ms_enabled') === 'true',
    connected: getConfigValue('ms_connected') === 'true',
    accountEmail: getConfigValue('ms_account_email'),
    accountType: (getConfigValue('ms_account_type') as 'msa' | 'entra') ?? null,
    enabledServices: services,
    lastVerifiedAt: getConfigValue('ms_last_verified_at'),
  };
}

export function isMicrosoftEnabled(): boolean {
  return getConfigValue('ms_enabled') === 'true';
}

export function isMicrosoftConnected(): boolean {
  return getConfigValue('ms_connected') === 'true';
}

export function getEnabledMsServices(): MicrosoftWorkspaceConfig['enabledServices'] {
  return getMicrosoftWorkspaceConfig().enabledServices;
}

export function getMsAccountType(): 'msa' | 'entra' | null {
  return (getConfigValue('ms_account_type') as 'msa' | 'entra') ?? null;
}

// ── Config Setters ──

export function setMicrosoftEnabled(enabled: boolean): void {
  setConfigValue('ms_enabled', String(enabled));
}

export function setMicrosoftConnected(connected: boolean, email?: string, accountType?: 'msa' | 'entra'): void {
  setConfigValue('ms_connected', String(connected));
  if (email) setConfigValue('ms_account_email', email);
  if (accountType) setConfigValue('ms_account_type', accountType);
  if (connected) {
    setConfigValue('ms_last_verified_at', new Date().toISOString());
    broadcast({ type: 'microsoft:connected', data: { email: email ?? '' } } as never);
  } else {
    broadcast({ type: 'microsoft:disconnected' } as never);
  }
}

export function setEnabledMsServices(services: Partial<MicrosoftWorkspaceConfig['enabledServices']>): void {
  const current = getEnabledMsServices();
  const updated = { ...current, ...services };
  setConfigValue('ms_enabled_services', JSON.stringify(updated));
}

// ── Client ID / Secret ──

export function getClientId(): string | null {
  return getConfigValue('ms_client_id');
}

export function getClientSecret(): string | null {
  return getConfigValue('ms_client_secret');
}

export function setClientCredentials(clientId: string, clientSecret?: string, tenantId?: string): void {
  setConfigValue('ms_client_id', clientId);
  if (clientSecret) setConfigValue('ms_client_secret', clientSecret);
  if (tenantId) setConfigValue('ms_tenant_id', tenantId);
}

export function getTenantId(): string | null {
  return getConfigValue('ms_tenant_id');
}

export function setAccountType(accountType: 'msa' | 'entra'): void {
  setConfigValue('ms_account_type', accountType);
}

// ── Token Management ──

export function getAccessToken(): string | null {
  return getConfigValue('ms_access_token');
}

export function getRefreshToken(): string | null {
  return getConfigValue('ms_refresh_token');
}

function getTokenExpiresAt(): number {
  const val = getConfigValue('ms_token_expires_at');
  return val ? parseInt(val, 10) : 0;
}

function storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): void {
  setConfigValue('ms_access_token', accessToken);
  if (refreshToken) setConfigValue('ms_refresh_token', refreshToken);
  setConfigValue('ms_token_expires_at', String(Date.now() + expiresIn * 1000));
}

// Mutex for token refresh to prevent concurrent refreshes
let refreshPromise: Promise<string | null> | null = null;

/**
 * Get a valid access token, refreshing if expired or about to expire.
 * Uses a mutex so concurrent calls don't race on refresh.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  const expiresAt = getTokenExpiresAt();

  // Still valid (with 5 minute buffer)
  if (token && Date.now() < expiresAt - 5 * 60 * 1000) {
    return token;
  }

  // Need to refresh — use mutex
  if (refreshPromise) return refreshPromise;

  refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  const clientId = getClientId();
  if (!refreshToken || !clientId) {
    logger.warn('Cannot refresh Microsoft token: missing refresh token or client ID');
    return null;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const clientSecret = getClientSecret();
  if (clientSecret) params.set('client_secret', clientSecret);

  try {
    const resp = await fetch(`${getAuthBase()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error('Microsoft token refresh failed', { status: resp.status, error: err });
      // If refresh token is invalid, mark as disconnected and alert the owner
      if (resp.status === 400 || resp.status === 401) {
        setMicrosoftConnected(false);
        logger.warn('Microsoft refresh token expired, marking disconnected');
        try {
          sendAlert('Microsoft 365 connection expired. Re-authenticate in Settings > Microsoft.', 'warning');
        } catch { /* iMessage bridge may not be running */ }
      }
      return null;
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in);
    logger.debug('Microsoft token refreshed');
    return data.access_token;
  } catch (err) {
    logger.error('Microsoft token refresh error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── OAuth Flow ──

export function buildAuthUrl(redirectUri: string): string {
  const clientId = getClientId();
  if (!clientId) throw new Error('Microsoft client ID not configured');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    prompt: 'consent',
    response_mode: 'query',
  });

  return `${getAuthBase()}/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  success: boolean;
  email?: string;
  accountType?: 'msa' | 'entra';
  error?: string;
}> {
  const clientId = getClientId();
  if (!clientId) return { success: false, error: 'Client ID not configured' };

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: SCOPES,
  });

  const clientSecret = getClientSecret();
  if (clientSecret) params.set('client_secret', clientSecret);

  try {
    const resp = await fetch(`${getAuthBase()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Token exchange failed (${resp.status}): ${errText.slice(0, 200)}` };
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      id_token?: string;
    };

    storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in);

    // Detect account type from id_token claims
    let accountType: 'msa' | 'entra' = 'entra';
    if (data.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
        if (payload.tid === MSA_TENANT_ID) accountType = 'msa';
      } catch { /* default to entra */ }
    }

    // Fetch user email from Graph
    let email = '';
    try {
      const meResp = await fetch(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (meResp.ok) {
        const me = await meResp.json() as { mail?: string; userPrincipalName?: string };
        email = me.mail ?? me.userPrincipalName ?? '';
      }
    } catch { /* best effort */ }

    setMicrosoftConnected(true, email, accountType);
    setMicrosoftEnabled(true);

    // Auto-disable Teams for personal accounts (MSA) — Teams requires Entra
    if (accountType === 'msa') {
      setEnabledMsServices({ teams: false });
    }

    logger.info('Microsoft 365 connected', { email, accountType });
    return { success: true, email, accountType };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Auth Verification ──

export async function testMicrosoftAuth(): Promise<{ authenticated: boolean; email: string | null }> {
  const token = await getValidAccessToken();
  if (!token) return { authenticated: false, email: null };

  try {
    const resp = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return { authenticated: false, email: null };

    const me = await resp.json() as { mail?: string; userPrincipalName?: string };
    const email = me.mail ?? me.userPrincipalName ?? null;
    setConfigValue('ms_last_verified_at', new Date().toISOString());
    return { authenticated: true, email };
  } catch {
    return { authenticated: false, email: null };
  }
}

export async function checkMicrosoftOnStartup(): Promise<void> {
  if (!isMicrosoftConnected()) return;

  const auth = await testMicrosoftAuth();
  if (auth.authenticated) {
    logger.info('Microsoft 365 auth verified', { email: auth.email });
  } else {
    logger.warn('Microsoft 365 auth expired or invalid, marking disconnected');
    setMicrosoftConnected(false);
  }
}

// ── Disconnect ──

export function disconnectMicrosoft(): void {
  const keys = [
    'ms_enabled', 'ms_connected', 'ms_account_email', 'ms_account_type',
    'ms_access_token', 'ms_refresh_token', 'ms_token_expires_at',
    'ms_last_verified_at', 'ms_tenant_id',
  ];
  for (const key of keys) deleteConfigValue(key);
  broadcast({ type: 'microsoft:disconnected' } as never);
  logger.info('Microsoft 365 disconnected');
}

// ── Access Level ──

export function getAgentMicrosoftAccessLevel(agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) return 'none';
  if (isPM) return 'none';
  if (isPrimary) return 'full';
  return 'read';
}
