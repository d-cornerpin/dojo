// ════════════════════════════════════════
// Microsoft 365 Auth — Public Client with PKCE
// Single registered app, no client secret, works for personal + work/school
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAlert } from '../services/imessage-bridge.js';

const logger = createLogger('ms-auth');

// ── Hardcoded public client — registered once by Cornerpin ──
const CLIENT_ID = '515c0ff6-31de-489d-a82c-75f5de836c50';

const MSA_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Use /common to accept both personal and work/school accounts
const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';

const SCOPES = [
  'openid', 'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.ReadWrite',
  'Chat.ReadWrite',
  'Notes.ReadWrite',
  'Tasks.ReadWrite',
  'Contacts.ReadWrite',
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
  try { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); } catch { /* best effort */ }
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

export function isMicrosoftEnabled(): boolean { return getConfigValue('ms_enabled') === 'true'; }
export function isMicrosoftConnected(): boolean { return getConfigValue('ms_connected') === 'true'; }
export function getEnabledMsServices(): MicrosoftWorkspaceConfig['enabledServices'] { return getMicrosoftWorkspaceConfig().enabledServices; }
export function getMsAccountType(): 'msa' | 'entra' | null { return (getConfigValue('ms_account_type') as 'msa' | 'entra') ?? null; }
export function getClientId(): string { return CLIENT_ID; }

// ── Config Setters ──

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

export function setMicrosoftEnabled(enabled: boolean): void { setConfigValue('ms_enabled', String(enabled)); }

export function setEnabledMsServices(services: Partial<MicrosoftWorkspaceConfig['enabledServices']>): void {
  const current = getEnabledMsServices();
  setConfigValue('ms_enabled_services', JSON.stringify({ ...current, ...services }));
}

// ── Token Management ──

export function getAccessToken(): string | null { return getConfigValue('ms_access_token'); }
function getRefreshToken(): string | null { return getConfigValue('ms_refresh_token'); }
function getTokenExpiresAt(): number { const v = getConfigValue('ms_token_expires_at'); return v ? parseInt(v, 10) : 0; }

function storeTokens(accessToken: string, refreshToken: string | null, expiresIn: number): void {
  setConfigValue('ms_access_token', accessToken);
  if (refreshToken) setConfigValue('ms_refresh_token', refreshToken);
  setConfigValue('ms_token_expires_at', String(Date.now() + expiresIn * 1000));
}

let refreshPromise: Promise<string | null> | null = null;

export async function getValidAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  const expiresAt = getTokenExpiresAt();
  if (token && Date.now() < expiresAt - 5 * 60 * 1000) return token;
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) { logger.warn('No refresh token'); return null; }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  try {
    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error('Token refresh failed', { status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        setMicrosoftConnected(false);
        try { sendAlert('Microsoft 365 connection expired. Re-authenticate in Settings > Microsoft.', 'warning'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
    storeTokens(data.access_token, data.refresh_token ?? null, data.expires_in);
    return data.access_token;
  } catch (err) {
    logger.error('Token refresh error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── PKCE ──

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Store the PKCE verifier so the callback can use it
let storedVerifier: string | null = null;
let storedRedirectUri: string | null = null;

export function getStoredVerifier(): string | null { return storedVerifier; }
export function getStoredRedirectUri(): string | null { return storedRedirectUri; }

// ── OAuth Flow ──

export function buildAuthUrl(redirectUri: string): { authUrl: string; verifier: string } {
  const { verifier, challenge } = generatePKCE();
  storedVerifier = verifier;
  storedRedirectUri = redirectUri;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    response_mode: 'query',
  });

  return { authUrl: `${AUTH_BASE}/authorize?${params.toString()}`, verifier };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string): Promise<{
  success: boolean;
  email?: string;
  accountType?: 'msa' | 'entra';
  error?: string;
}> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPES,
  });

  try {
    const resp = await fetch(`${AUTH_BASE}/token`, {
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

    // Detect account type from id_token
    let accountType: 'msa' | 'entra' = 'entra';
    if (data.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString());
        if (payload.tid === MSA_TENANT_ID) accountType = 'msa';
      } catch {}
    }

    // Fetch email
    let email = '';
    try {
      const meResp = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${data.access_token}` } });
      if (meResp.ok) {
        const me = await meResp.json() as { mail?: string; userPrincipalName?: string };
        email = me.mail ?? me.userPrincipalName ?? '';
      }
    } catch {}

    setMicrosoftConnected(true, email, accountType);
    setMicrosoftEnabled(true);
    if (accountType === 'msa') setEnabledMsServices({ teams: false });

    logger.info('Microsoft 365 connected', { email, accountType });

    // Install Office document packages in the background
    try {
      const { installOfficePackages } = await import('./office-packages.js');
      installOfficePackages();
    } catch { /* best effort */ }

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
    const resp = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { authenticated: false, email: null };
    const me = await resp.json() as { mail?: string; userPrincipalName?: string };
    setConfigValue('ms_last_verified_at', new Date().toISOString());
    return { authenticated: true, email: me.mail ?? me.userPrincipalName ?? null };
  } catch { return { authenticated: false, email: null }; }
}

export async function checkMicrosoftOnStartup(): Promise<void> {
  if (!isMicrosoftConnected()) return;
  const auth = await testMicrosoftAuth();
  if (auth.authenticated) { logger.info('Microsoft 365 auth verified', { email: auth.email }); }
  else { logger.warn('Microsoft 365 auth failed, marking disconnected'); setMicrosoftConnected(false); }
}

// ── Disconnect ──

export function disconnectMicrosoft(): void {
  for (const key of ['ms_enabled', 'ms_connected', 'ms_account_email', 'ms_account_type', 'ms_access_token', 'ms_refresh_token', 'ms_token_expires_at', 'ms_last_verified_at', 'ms_enabled_services']) {
    deleteConfigValue(key);
  }
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
