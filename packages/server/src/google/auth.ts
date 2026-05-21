// ════════════════════════════════════════
// Google Workspace Auth — Native OAuth 2.0
// No gws CLI dependency. Direct REST API with auto-refresh.
// Mirrors the Microsoft auth.ts pattern.
//
// v2.7.0 — multi-account support. A dojo can connect TWO Google
// accounts: the "agent" slot (the agent's own identity, default) and
// the "user" slot (the human user's account, used for reads on their
// behalf). All public functions accept an optional `slot` parameter
// that defaults to 'agent' — every existing caller keeps working
// unchanged.
//
// Storage strategy: the agent slot uses the legacy unprefixed config
// keys (gws_access_token, etc.) — no migration needed for existing
// installs. The user slot uses '_user_' infixed keys
// (gws_user_access_token). New installs get the user slot only if
// they explicitly connect a second account.
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
  // v2.5.5 — Forms create/edit + read responses
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
].join(' ');

// Exported as an array for downstream code that needs to compare against a
// token's granted scopes (e.g. detecting "user is connected but missing the
// new Forms scopes — needs to reconnect").
export const REQUIRED_SCOPES: readonly string[] = SCOPES.split(' ');

// ── Slot abstraction ──

export type AccountSlot = 'agent' | 'user';
export const ACCOUNT_SLOTS: readonly AccountSlot[] = ['agent', 'user'];

/**
 * Map a (slot, field) pair to the canonical config-table key.
 * - Agent slot uses the legacy unprefixed keys so existing installs
 *   migrate to v2.7 with zero data movement.
 * - User slot uses '_user_' infixed keys.
 */
function slotKey(slot: AccountSlot, field: string): string {
  if (slot === 'agent') return `gws_${field}`;
  return `gws_user_${field}`;
}

/**
 * v2.5.5 — Normalize scope IDs to a canonical form for set comparison.
 * Google's auth flow accepts shorthand ("email", "profile") but tokeninfo
 * reports them back as full URLs ("https://www.googleapis.com/auth/userinfo.email").
 * Without this normalization, the missing-scopes diff thinks "email" is
 * missing even when "userinfo.email" is granted.
 */
function canonicalizeScope(scope: string): string {
  if (scope === 'email') return 'https://www.googleapis.com/auth/userinfo.email';
  if (scope === 'profile') return 'https://www.googleapis.com/auth/userinfo.profile';
  return scope;
}

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
    forms: boolean;
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
  forms: true,
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

export function getGoogleWorkspaceConfig(slot: AccountSlot = 'agent'): GoogleWorkspaceConfig {
  const servicesRaw = getConfigValue(slotKey(slot, 'enabled_services'));
  let services = { ...DEFAULT_SERVICES };
  if (servicesRaw) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(servicesRaw) }; } catch { /* defaults */ }
  }

  return {
    enabled: getConfigValue(slotKey(slot, 'enabled')) === 'true',
    connected: getConfigValue(slotKey(slot, 'connected')) === 'true',
    accountEmail: getConfigValue(slotKey(slot, 'account_email')),
    enabledServices: services,
    lastVerifiedAt: getConfigValue(slotKey(slot, 'last_verified_at')),
  };
}

export function isGoogleEnabled(slot: AccountSlot = 'agent'): boolean {
  return getConfigValue(slotKey(slot, 'enabled')) === 'true';
}

export function isGoogleConnected(slot: AccountSlot = 'agent'): boolean {
  return getConfigValue(slotKey(slot, 'connected')) === 'true';
}

export function getEnabledServices(slot: AccountSlot = 'agent'): GoogleWorkspaceConfig['enabledServices'] {
  return getGoogleWorkspaceConfig(slot).enabledServices;
}

/**
 * Whether the Gmail watcher should poll this slot's inbox for new mail and
 * forward notifications to the primary agent. Defaults true for the agent
 * slot (preserves single-account v2.6 behavior) and false for the user slot
 * (a personal inbox connected as "user" shouldn't auto-forward without an
 * explicit opt-in). Migration in seedDefaultEmailMonitoring() sets the agent
 * key on first boot for installs upgrading from v2.6.
 */
export function isEmailMonitoringEnabled(slot: AccountSlot = 'agent'): boolean {
  const v = getConfigValue(slotKey(slot, 'watch_email'));
  if (v !== null) return v === 'true';
  return slot === 'agent';
}

export function setEmailMonitoringEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  setConfigValue(slotKey(slot, 'watch_email'), String(enabled));
}

/**
 * Whether the agent is allowed to send/reply/forward email from this slot.
 * Defaults true for the agent slot (preserves v2.6/v2.7.0 behavior where
 * the agent's own account could send) and false for the user slot (a
 * personal account shouldn't grant outbound permission just by connecting —
 * the user opts in explicitly). Send tools refuse with a structured message
 * naming the toggle when this is off.
 */
export function isEmailSendingEnabled(slot: AccountSlot = 'agent'): boolean {
  const v = getConfigValue(slotKey(slot, 'send_email'));
  if (v !== null) return v === 'true';
  return slot === 'agent';
}

export function setEmailSendingEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  setConfigValue(slotKey(slot, 'send_email'), String(enabled));
}

// ── Config Setters ──

export function setGoogleEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  setConfigValue(slotKey(slot, 'enabled'), String(enabled));
}

export function setGoogleConnected(connected: boolean, email?: string, slot: AccountSlot = 'agent'): void {
  setConfigValue(slotKey(slot, 'connected'), String(connected));
  if (email) {
    setConfigValue(slotKey(slot, 'account_email'), email);
  }
  if (connected) {
    setConfigValue(slotKey(slot, 'last_verified_at'), new Date().toISOString());
    broadcast({ type: 'google:connected', data: { email: email ?? '', slot } } as never);
  } else {
    broadcast({ type: 'google:disconnected', data: { slot } } as never);
  }
}

export function setEnabledServices(services: Partial<GoogleWorkspaceConfig['enabledServices']>, slot: AccountSlot = 'agent'): void {
  const current = getEnabledServices(slot);
  setConfigValue(slotKey(slot, 'enabled_services'), JSON.stringify({ ...current, ...services }));
}

// ── Token Management ──

function getAccessToken(slot: AccountSlot): string | null { return getConfigValue(slotKey(slot, 'access_token')); }
function getRefreshToken(slot: AccountSlot): string | null { return getConfigValue(slotKey(slot, 'refresh_token')); }
function getTokenExpiresAt(slot: AccountSlot): number { const v = getConfigValue(slotKey(slot, 'token_expires_at')); return v ? parseInt(v, 10) : 0; }

function storeTokens(slot: AccountSlot, accessToken: string, refreshToken: string | null, expiresIn: number, grantedScopes?: string): void {
  setConfigValue(slotKey(slot, 'access_token'), accessToken);
  if (refreshToken) setConfigValue(slotKey(slot, 'refresh_token'), refreshToken);
  setConfigValue(slotKey(slot, 'token_expires_at'), String(Date.now() + expiresIn * 1000));
  // v2.5.5 — track which scopes Google actually granted, so we can detect
  // when an existing user is missing scopes that were added in a later
  // release (e.g. Forms scopes added after user already connected).
  // refresh_token responses don't always include `scope`; only update when present.
  if (grantedScopes) setConfigValue(slotKey(slot, 'granted_scopes'), grantedScopes);
}

/**
 * v2.5.5 — Returns scopes from REQUIRED_SCOPES that the connected user has
 * NOT granted. Empty array means everything is fine. Non-empty means the
 * user connected before the scope list was extended and needs to re-consent.
 *
 * Returns empty array if the user is not connected at all (different problem).
 */
export function getMissingScopes(slot: AccountSlot = 'agent'): string[] {
  if (!isGoogleConnected(slot)) return [];
  const granted = getConfigValue(slotKey(slot, 'granted_scopes'));
  if (!granted) {
    return [...REQUIRED_SCOPES];
  }
  const grantedSet = new Set(granted.split(' ').map(canonicalizeScope));
  return REQUIRED_SCOPES.filter((s) => !grantedSet.has(canonicalizeScope(s)));
}

/**
 * v2.5.5 — Probe Google's tokeninfo endpoint with the current access token
 * to learn which scopes were actually granted, then persist them.
 */
export async function discoverGrantedScopes(slot: AccountSlot = 'agent'): Promise<void> {
  if (!isGoogleConnected(slot)) return;
  if (getConfigValue(slotKey(slot, 'granted_scopes'))) return; // already known
  const token = await getValidAccessToken(slot);
  if (!token) return;
  try {
    const resp = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return;
    const data = await resp.json() as { scope?: string };
    if (data.scope) {
      setConfigValue(slotKey(slot, 'granted_scopes'), data.scope);
      logger.info('Discovered granted Google scopes', { slot, count: data.scope.split(' ').length });
    }
  } catch (e) {
    logger.warn('discoverGrantedScopes failed', { slot, error: e instanceof Error ? e.message : String(e) });
  }
}

// Per-slot refresh mutex.
const refreshPromises: Map<AccountSlot, Promise<string | null> | null> = new Map();

export async function getValidAccessToken(slot: AccountSlot = 'agent'): Promise<string | null> {
  const token = getAccessToken(slot);
  const expiresAt = getTokenExpiresAt(slot);
  // Return current token if valid with 5-minute buffer
  if (token && Date.now() < expiresAt - 5 * 60 * 1000) return token;
  // Deduplicate concurrent refresh calls per slot
  const existing = refreshPromises.get(slot);
  if (existing) return existing;
  const promise = refreshAccessToken(slot).finally(() => { refreshPromises.set(slot, null); });
  refreshPromises.set(slot, promise);
  return promise;
}

async function refreshAccessToken(slot: AccountSlot): Promise<string | null> {
  const refreshToken = getRefreshToken(slot);
  if (!refreshToken) {
    logger.warn('No Google refresh token available', { slot });
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
      logger.error('Google token refresh failed', { slot, status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        setGoogleConnected(false, undefined, slot);
        // v2.3.19 — OAuth expiry is a true blocker. Critical.
        const slotLabel = slot === 'user' ? "user's" : "agent's";
        try { sendAlert(`Google Workspace (${slotLabel} account) connection expired. Re-authenticate in Settings > Google.`, 'critical'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    storeTokens(slot, data.access_token, data.refresh_token ?? null, data.expires_in, data.scope);
    logger.debug('Google access token refreshed', { slot });
    return data.access_token;
  } catch (err) {
    logger.error('Google token refresh error', { slot, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── OAuth Flow ──

// Per-slot OAuth state. Each slot can have an in-flight OAuth flow
// independently — Crystal could be connecting her secondary account
// while the agent's flow is also pending.
interface OAuthState { state: string; redirectUri: string }
const oauthStateBySlot: Map<AccountSlot, OAuthState | null> = new Map();
// Reverse-lookup map: state-token → slot. Lets the callback recover
// which slot the redirect belongs to without trusting query params.
const slotByState: Map<string, AccountSlot> = new Map();

export function getStoredState(slot: AccountSlot = 'agent'): string | null {
  return oauthStateBySlot.get(slot)?.state ?? null;
}
export function getStoredRedirectUri(slot: AccountSlot = 'agent'): string | null {
  return oauthStateBySlot.get(slot)?.redirectUri ?? null;
}

/** Reverse-lookup the slot for a given state token. Used by /callback
 *  to recover the slot identity from the OAuth roundtrip. */
export function getSlotForState(state: string): AccountSlot | null {
  return slotByState.get(state) ?? null;
}

export function buildAuthUrl(redirectUri: string, slot: AccountSlot = 'agent'): { authUrl: string } {
  // Evict any stale state from a previous abandoned OAuth attempt for
  // this slot — keeps the reverse-lookup map from growing unboundedly
  // when a user clicks "Sign in" multiple times without finishing.
  const prior = oauthStateBySlot.get(slot);
  if (prior) slotByState.delete(prior.state);

  const state = crypto.randomBytes(16).toString('hex');
  oauthStateBySlot.set(slot, { state, redirectUri });
  slotByState.set(state, slot);

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

export async function exchangeCodeForTokens(code: string, redirectUri: string, slot: AccountSlot = 'agent'): Promise<{
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

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string };
    storeTokens(slot, data.access_token, data.refresh_token ?? null, data.expires_in, data.scope);

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

    setGoogleConnected(true, email, slot);
    setGoogleEnabled(true, slot);

    // Clean up the OAuth state for this slot now that it's complete.
    const stored = oauthStateBySlot.get(slot);
    if (stored) {
      slotByState.delete(stored.state);
      oauthStateBySlot.set(slot, null);
    }

    // Soft warning if the user connected the same email to both slots.
    // Not a hard refusal — there are legitimate reasons (e.g. testing,
    // recovering from misconfiguration) — but log it loudly so we have
    // a breadcrumb if "why are agent and user accounts the same" comes
    // up as a support question.
    if (email) {
      const otherSlot: AccountSlot = slot === 'agent' ? 'user' : 'agent';
      const otherEmail = getConfigValue(slotKey(otherSlot, 'account_email'));
      if (otherEmail && otherEmail.toLowerCase() === email.toLowerCase() && isGoogleConnected(otherSlot)) {
        logger.warn('Google: same email connected to both slots', { slot, otherSlot, email });
      }
    }

    logger.info('Google Workspace connected', { slot, email });
    return { success: true, email };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Auth Verification ──

export async function testGoogleAuth(slot: AccountSlot = 'agent'): Promise<{ authenticated: boolean; email: string | null }> {
  const token = await getValidAccessToken(slot);
  if (!token) return { authenticated: false, email: null };

  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { authenticated: false, email: null };
    const user = await resp.json() as { email?: string };
    setConfigValue(slotKey(slot, 'last_verified_at'), new Date().toISOString());
    return { authenticated: true, email: user.email ?? null };
  } catch {
    return { authenticated: false, email: null };
  }
}

export async function checkGoogleOnStartup(): Promise<void> {
  // Check both slots on startup. Each runs independently — failure on
  // one slot doesn't disable the other.
  for (const slot of ACCOUNT_SLOTS) {
    if (!isGoogleConnected(slot)) continue;
    const auth = await testGoogleAuth(slot);
    if (auth.authenticated) {
      logger.info('Google Workspace auth verified', { slot, email: auth.email });
    } else {
      logger.warn('Google Workspace auth expired, marking disconnected', { slot });
      setGoogleConnected(false, undefined, slot);
    }
  }
}

// ── Disconnect ──

export function disconnectGoogle(slot: AccountSlot = 'agent'): void {
  const fields = ['enabled', 'connected', 'account_email', 'access_token', 'refresh_token', 'token_expires_at', 'last_verified_at', 'enabled_services', 'granted_scopes'];
  for (const field of fields) {
    deleteConfigValue(slotKey(slot, field));
  }
  broadcast({ type: 'google:disconnected', data: { slot } } as never);
  logger.info('Google Workspace disconnected', { slot });
}

// ── Access Level ──

export function getAgentGoogleAccessLevel(_agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  // Access level is computed per AGENT (primary/PM/etc.) not per slot.
  // If EITHER slot is enabled+connected, the agent has some level of
  // Google access. Slot routing happens at tool-call time.
  const anyEnabled = isGoogleEnabled('agent') || isGoogleEnabled('user');
  const anyConnected = isGoogleConnected('agent') || isGoogleConnected('user');
  if (!anyEnabled || !anyConnected) return 'none';
  if (isPM) return 'none';
  if (isPrimary) return 'full';
  return 'read';
}
