// ════════════════════════════════════════
// Microsoft 365 Auth — Public Client with PKCE
// Single registered app, no client secret, works for personal + work/school
//
// v2.7.0 — multi-account support. Same pattern as google/auth.ts:
// agent slot uses legacy unprefixed keys (zero migration); user slot
// uses '_user_' infixed keys. Every public function takes an optional
// `slot` parameter that defaults to 'agent' so existing callers are
// unchanged.
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
  'Calendars.ReadWrite.Shared',
  'Files.ReadWrite',
  'Files.ReadWrite.All',
  'Sites.ReadWrite.All',
  'OnlineMeetings.ReadWrite',
  'Chat.ReadWrite',
  'Notes.ReadWrite',
  'Tasks.ReadWrite',
  'Contacts.ReadWrite',
].join(' ');

// ── Slot abstraction ──

export type AccountSlot = 'agent' | 'user';
export const ACCOUNT_SLOTS: readonly AccountSlot[] = ['agent', 'user'];

function slotKey(slot: AccountSlot, field: string): string {
  if (slot === 'agent') return `ms_${field}`;
  return `ms_user_${field}`;
}

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

export function getMicrosoftWorkspaceConfig(slot: AccountSlot = 'agent'): MicrosoftWorkspaceConfig {
  const servicesRaw = getConfigValue(slotKey(slot, 'enabled_services'));
  let services = { ...DEFAULT_SERVICES };
  if (servicesRaw) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(servicesRaw) }; } catch { /* defaults */ }
  }
  return {
    enabled: getConfigValue(slotKey(slot, 'enabled')) === 'true',
    connected: getConfigValue(slotKey(slot, 'connected')) === 'true',
    accountEmail: getConfigValue(slotKey(slot, 'account_email')),
    accountType: (getConfigValue(slotKey(slot, 'account_type')) as 'msa' | 'entra') ?? null,
    enabledServices: services,
    lastVerifiedAt: getConfigValue(slotKey(slot, 'last_verified_at')),
  };
}

export function isMicrosoftEnabled(slot: AccountSlot = 'agent'): boolean { return getConfigValue(slotKey(slot, 'enabled')) === 'true'; }
export function isMicrosoftConnected(slot: AccountSlot = 'agent'): boolean { return getConfigValue(slotKey(slot, 'connected')) === 'true'; }
export function getEnabledMsServices(slot: AccountSlot = 'agent'): MicrosoftWorkspaceConfig['enabledServices'] { return getMicrosoftWorkspaceConfig(slot).enabledServices; }
export function getMsAccountType(slot: AccountSlot = 'agent'): 'msa' | 'entra' | null { return (getConfigValue(slotKey(slot, 'account_type')) as 'msa' | 'entra') ?? null; }
export function getClientId(): string { return CLIENT_ID; }

// ── Config Setters ──

export function setMicrosoftConnected(connected: boolean, email?: string, accountType?: 'msa' | 'entra', slot: AccountSlot = 'agent'): void {
  setConfigValue(slotKey(slot, 'connected'), String(connected));
  if (email) setConfigValue(slotKey(slot, 'account_email'), email);
  if (accountType) setConfigValue(slotKey(slot, 'account_type'), accountType);
  if (connected) {
    setConfigValue(slotKey(slot, 'last_verified_at'), new Date().toISOString());
    broadcast({ type: 'microsoft:connected', data: { email: email ?? '', slot } } as never);
  } else {
    broadcast({ type: 'microsoft:disconnected', data: { slot } } as never);
  }
}

export function setMicrosoftEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void { setConfigValue(slotKey(slot, 'enabled'), String(enabled)); }

export function setEnabledMsServices(services: Partial<MicrosoftWorkspaceConfig['enabledServices']>, slot: AccountSlot = 'agent'): void {
  const current = getEnabledMsServices(slot);
  setConfigValue(slotKey(slot, 'enabled_services'), JSON.stringify({ ...current, ...services }));
}

// ── Token Management ──

export function getAccessToken(slot: AccountSlot = 'agent'): string | null { return getConfigValue(slotKey(slot, 'access_token')); }
function getRefreshToken(slot: AccountSlot): string | null { return getConfigValue(slotKey(slot, 'refresh_token')); }
function getTokenExpiresAt(slot: AccountSlot): number { const v = getConfigValue(slotKey(slot, 'token_expires_at')); return v ? parseInt(v, 10) : 0; }

function storeTokens(slot: AccountSlot, accessToken: string, refreshToken: string | null, expiresIn: number): void {
  setConfigValue(slotKey(slot, 'access_token'), accessToken);
  if (refreshToken) setConfigValue(slotKey(slot, 'refresh_token'), refreshToken);
  setConfigValue(slotKey(slot, 'token_expires_at'), String(Date.now() + expiresIn * 1000));
}

// Per-slot refresh mutex.
const refreshPromises: Map<AccountSlot, Promise<string | null> | null> = new Map();

export async function getValidAccessToken(slot: AccountSlot = 'agent'): Promise<string | null> {
  const token = getAccessToken(slot);
  const expiresAt = getTokenExpiresAt(slot);
  if (token && Date.now() < expiresAt - 5 * 60 * 1000) return token;
  const existing = refreshPromises.get(slot);
  if (existing) return existing;
  const promise = refreshAccessToken(slot).finally(() => { refreshPromises.set(slot, null); });
  refreshPromises.set(slot, promise);
  return promise;
}

async function refreshAccessToken(slot: AccountSlot): Promise<string | null> {
  const refreshToken = getRefreshToken(slot);
  if (!refreshToken) { logger.warn('No refresh token', { slot }); return null; }

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
      logger.error('Token refresh failed', { slot, status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        setMicrosoftConnected(false, undefined, undefined, slot);
        const slotLabel = slot === 'user' ? "user's" : "agent's";
        try { sendAlert(`Microsoft 365 (${slotLabel} account) connection expired. Re-authenticate in Settings > Microsoft.`, 'critical'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
    storeTokens(slot, data.access_token, data.refresh_token ?? null, data.expires_in);
    return data.access_token;
  } catch (err) {
    logger.error('Token refresh error', { slot, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── PKCE ──

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Per-slot PKCE state. Each slot has its own in-flight OAuth context.
interface OAuthState { verifier: string; redirectUri: string; stateToken: string }
const oauthStateBySlot: Map<AccountSlot, OAuthState | null> = new Map();
const slotByStateToken: Map<string, AccountSlot> = new Map();

export function getStoredVerifier(slot: AccountSlot = 'agent'): string | null {
  return oauthStateBySlot.get(slot)?.verifier ?? null;
}
export function getStoredRedirectUri(slot: AccountSlot = 'agent'): string | null {
  return oauthStateBySlot.get(slot)?.redirectUri ?? null;
}
/** Reverse-lookup slot for a state token recovered from /callback. */
export function getSlotForState(state: string): AccountSlot | null {
  return slotByStateToken.get(state) ?? null;
}

// ── OAuth Flow ──

export function buildAuthUrl(redirectUri: string, slot: AccountSlot = 'agent'): { authUrl: string; verifier: string; state: string } {
  // Evict stale state from a previous abandoned attempt for this slot.
  const prior = oauthStateBySlot.get(slot);
  if (prior) slotByStateToken.delete(prior.stateToken);

  const { verifier, challenge } = generatePKCE();
  const stateToken = crypto.randomBytes(16).toString('hex');
  oauthStateBySlot.set(slot, { verifier, redirectUri, stateToken });
  slotByStateToken.set(stateToken, slot);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    response_mode: 'query',
    state: stateToken,
  });

  return { authUrl: `${AUTH_BASE}/authorize?${params.toString()}`, verifier, state: stateToken };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string, slot: AccountSlot = 'agent'): Promise<{
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
    storeTokens(slot, data.access_token, data.refresh_token ?? null, data.expires_in);

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

    setMicrosoftConnected(true, email, accountType, slot);
    setMicrosoftEnabled(true, slot);
    if (accountType === 'msa') setEnabledMsServices({ teams: false }, slot);

    // Clean up the OAuth state for this slot.
    const stored = oauthStateBySlot.get(slot);
    if (stored) {
      slotByStateToken.delete(stored.stateToken);
      oauthStateBySlot.set(slot, null);
    }

    // Same-email soft warning (see Google version for rationale).
    if (email) {
      const otherSlot: AccountSlot = slot === 'agent' ? 'user' : 'agent';
      const otherEmail = getConfigValue(slotKey(otherSlot, 'account_email'));
      if (otherEmail && otherEmail.toLowerCase() === email.toLowerCase() && isMicrosoftConnected(otherSlot)) {
        logger.warn('Microsoft: same email connected to both slots', { slot, otherSlot, email });
      }
    }

    logger.info('Microsoft 365 connected', { slot, email, accountType });

    // Install Office document packages in the background (idempotent).
    // Only fire when the agent slot connects to avoid double-install.
    if (slot === 'agent') {
      try {
        const { installOfficePackages } = await import('./office-packages.js');
        installOfficePackages();
      } catch { /* best effort */ }
    }

    return { success: true, email, accountType };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Auth Verification ──

export async function testMicrosoftAuth(slot: AccountSlot = 'agent'): Promise<{ authenticated: boolean; email: string | null }> {
  const token = await getValidAccessToken(slot);
  if (!token) return { authenticated: false, email: null };
  try {
    const resp = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { authenticated: false, email: null };
    const me = await resp.json() as { mail?: string; userPrincipalName?: string };
    setConfigValue(slotKey(slot, 'last_verified_at'), new Date().toISOString());
    return { authenticated: true, email: me.mail ?? me.userPrincipalName ?? null };
  } catch { return { authenticated: false, email: null }; }
}

export async function checkMicrosoftOnStartup(): Promise<void> {
  for (const slot of ACCOUNT_SLOTS) {
    if (!isMicrosoftConnected(slot)) continue;
    const auth = await testMicrosoftAuth(slot);
    if (auth.authenticated) { logger.info('Microsoft 365 auth verified', { slot, email: auth.email }); }
    else { logger.warn('Microsoft 365 auth failed, marking disconnected', { slot }); setMicrosoftConnected(false, undefined, undefined, slot); }
  }
}

// ── Disconnect ──

export function disconnectMicrosoft(slot: AccountSlot = 'agent'): void {
  const fields = ['enabled', 'connected', 'account_email', 'account_type', 'access_token', 'refresh_token', 'token_expires_at', 'last_verified_at', 'enabled_services'];
  for (const field of fields) {
    deleteConfigValue(slotKey(slot, field));
  }
  broadcast({ type: 'microsoft:disconnected', data: { slot } } as never);
  logger.info('Microsoft 365 disconnected', { slot });
}

// ── Access Level ──

export function getAgentMicrosoftAccessLevel(_agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  // Same any-slot-counts rule as Google.
  const anyEnabled = isMicrosoftEnabled('agent') || isMicrosoftEnabled('user');
  const anyConnected = isMicrosoftConnected('agent') || isMicrosoftConnected('user');
  if (!anyEnabled || !anyConnected) return 'none';
  if (isPM) return 'none';
  if (isPrimary) return 'full';
  return 'read';
}
