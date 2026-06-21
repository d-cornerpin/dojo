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
import {
  countGoogleAccounts,
  deleteGoogleAccount,
  getGoogleAccount,
  getPrimaryGoogleAccount,
  insertGoogleAccount,
  listGoogleAccounts,
  updateGoogleAccount,
  MAX_ACCOUNTS_PER_KIND,
  type GoogleAccount,
} from './accounts.js';
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

// The legacy slot ('agent'/'user') now resolves to that KIND's position-1
// account row (Path B, layer 2). The kind is the permission boundary and is
// identical to the slot value, so a slot is passed straight through as a kind.

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

// ── Slot → account resolution ──

/** The kind's position-1 account row, or null on a fresh (unconnected) install. */
function slotAccount(slot: AccountSlot): GoogleAccount | null {
  return getPrimaryGoogleAccount(slot);
}

/**
 * The kind's position-1 row, created on demand for setters. A brand-new
 * primary account preserves the historical kind defaults (agent watch/send
 * default ON, user OFF); id == kind keeps it addressable as the legacy slot.
 */
function ensureSlotAccount(slot: AccountSlot): GoogleAccount {
  const existing = getPrimaryGoogleAccount(slot);
  if (existing) return existing;
  return insertGoogleAccount({
    id: slot,
    kind: slot,
    position: 1,
    watchEmail: slot === 'agent',
    sendEmail: slot === 'agent',
  });
}

function parseServices(json: string | null): GoogleWorkspaceConfig['enabledServices'] {
  let services = { ...DEFAULT_SERVICES };
  if (json) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(json) }; } catch { /* defaults */ }
  }
  return services;
}

// ── Config Getters ──

export function getGoogleWorkspaceConfig(slot: AccountSlot = 'agent'): GoogleWorkspaceConfig {
  const acc = slotAccount(slot);
  return {
    enabled: acc?.enabled ?? false,
    connected: acc?.connected ?? false,
    accountEmail: acc?.email ?? null,
    enabledServices: parseServices(acc?.enabledServices ?? null),
    lastVerifiedAt: acc?.lastVerifiedAt ?? null,
  };
}

export function isGoogleEnabled(slot: AccountSlot = 'agent'): boolean {
  return slotAccount(slot)?.enabled ?? false;
}

export function isGoogleConnected(slot: AccountSlot = 'agent'): boolean {
  return slotAccount(slot)?.connected ?? false;
}

export function getEnabledServices(slot: AccountSlot = 'agent'): GoogleWorkspaceConfig['enabledServices'] {
  return getGoogleWorkspaceConfig(slot).enabledServices;
}

// ── Kind-level aggregation (multi-account aware) ──
// A kind's tools should be offered if ANY of that kind's connected accounts
// has the service enabled — not just the position-1 row. Used by tool
// filtering so adding a second account widens the available surface.

export function isAnyGoogleAccountConnected(slot: AccountSlot): boolean {
  return listGoogleAccounts(slot).some(a => a.connected);
}

export function isGoogleServiceEnabledForKind(
  slot: AccountSlot,
  service: keyof GoogleWorkspaceConfig['enabledServices'],
): boolean {
  return listGoogleAccounts(slot).some(a => a.connected && parseServices(a.enabledServices)[service]);
}

// ── Per-account setters (dashboard manages individual accounts by id) ──

export function setEnabledServicesForAccount(
  accountId: string,
  services: Partial<GoogleWorkspaceConfig['enabledServices']>,
): void {
  const acc = getGoogleAccount(accountId);
  if (!acc) return;
  const current = parseServices(acc.enabledServices);
  updateGoogleAccount(accountId, { enabledServices: JSON.stringify({ ...current, ...services }) });
}

export function setEmailMonitoringEnabledForAccount(accountId: string, enabled: boolean): void {
  if (!getGoogleAccount(accountId)) return;
  updateGoogleAccount(accountId, { watchEmail: enabled });
}

export function setEmailSendingEnabledForAccount(accountId: string, enabled: boolean): void {
  if (!getGoogleAccount(accountId)) return;
  updateGoogleAccount(accountId, { sendEmail: enabled });
}

/** Sanitized per-account view for the dashboard — never includes tokens. */
export interface GoogleAccountView {
  id: string;
  kind: AccountSlot;
  position: number;
  email: string | null;
  enabled: boolean;
  connected: boolean;
  services: GoogleWorkspaceConfig['enabledServices'];
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerified: string | null;
}

export function listGoogleAccountViews(): GoogleAccountView[] {
  return listGoogleAccounts().map(a => ({
    id: a.id,
    kind: a.kind,
    position: a.position,
    email: a.email,
    enabled: a.enabled,
    connected: a.connected,
    services: parseServices(a.enabledServices),
    watchEmail: a.watchEmail,
    sendEmail: a.sendEmail,
    lastVerified: a.lastVerifiedAt,
  }));
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
  const acc = slotAccount(slot);
  if (acc) return acc.watchEmail;
  return slot === 'agent';
}

export function setEmailMonitoringEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateGoogleAccount(ensureSlotAccount(slot).id, { watchEmail: enabled });
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
  const acc = slotAccount(slot);
  if (acc) return acc.sendEmail;
  return slot === 'agent';
}

export function setEmailSendingEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateGoogleAccount(ensureSlotAccount(slot).id, { sendEmail: enabled });
}

// ── Config Setters ──

export function setGoogleEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateGoogleAccount(ensureSlotAccount(slot).id, { enabled });
}

export function setGoogleConnected(connected: boolean, email?: string, slot: AccountSlot = 'agent'): void {
  const patch: Partial<Omit<GoogleAccount, 'id' | 'kind' | 'position'>> = { connected };
  if (email) patch.email = email;
  if (connected) patch.lastVerifiedAt = new Date().toISOString();
  updateGoogleAccount(ensureSlotAccount(slot).id, patch);
  if (connected) {
    broadcast({ type: 'google:connected', data: { email: email ?? '', slot } } as never);
  } else {
    broadcast({ type: 'google:disconnected', data: { slot } } as never);
  }
}

export function setEnabledServices(services: Partial<GoogleWorkspaceConfig['enabledServices']>, slot: AccountSlot = 'agent'): void {
  const current = getEnabledServices(slot);
  updateGoogleAccount(ensureSlotAccount(slot).id, { enabledServices: JSON.stringify({ ...current, ...services }) });
}

// ── Token Management ──

/**
 * v2.5.5 — Returns scopes from REQUIRED_SCOPES that the connected user has
 * NOT granted. Empty array means everything is fine. Non-empty means the
 * user connected before the scope list was extended and needs to re-consent.
 *
 * Returns empty array if the user is not connected at all (different problem).
 */
export function getMissingScopes(slot: AccountSlot = 'agent'): string[] {
  if (!isGoogleConnected(slot)) return [];
  const granted = slotAccount(slot)?.grantedScopes ?? null;
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
  if (slotAccount(slot)?.grantedScopes) return; // already known
  const token = await getValidAccessToken(slot);
  if (!token) return;
  try {
    const resp = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return;
    const data = await resp.json() as { scope?: string };
    if (data.scope) {
      updateGoogleAccount(ensureSlotAccount(slot).id, { grantedScopes: data.scope });
      logger.info('Discovered granted Google scopes', { slot, count: data.scope.split(' ').length });
    }
  } catch (e) {
    logger.warn('discoverGrantedScopes failed', { slot, error: e instanceof Error ? e.message : String(e) });
  }
}

// Per-ACCOUNT refresh mutex (keyed by account id, not kind — each connected
// account refreshes independently).
const refreshPromises: Map<string, Promise<string | null> | null> = new Map();

/**
 * Valid access token for a SPECIFIC account (by id), refreshing if needed.
 * This is the account-aware primitive; the slot wrapper below resolves a
 * kind to its position-1 account and delegates here.
 */
export async function getValidAccessTokenForAccount(accountId: string): Promise<string | null> {
  const acc = getGoogleAccount(accountId);
  if (!acc) return null;
  // Return current token if valid with 5-minute buffer
  if (acc.accessToken && Date.now() < (acc.tokenExpiresAt ?? 0) - 5 * 60 * 1000) return acc.accessToken;
  // Deduplicate concurrent refresh calls per account
  const existing = refreshPromises.get(accountId);
  if (existing) return existing;
  const promise = refreshAccessTokenForAccount(accountId).finally(() => { refreshPromises.set(accountId, null); });
  refreshPromises.set(accountId, promise);
  return promise;
}

export async function getValidAccessToken(slot: AccountSlot = 'agent'): Promise<string | null> {
  const acc = getPrimaryGoogleAccount(slot);
  if (!acc) return null;
  return getValidAccessTokenForAccount(acc.id);
}

async function refreshAccessTokenForAccount(accountId: string): Promise<string | null> {
  const acc = getGoogleAccount(accountId);
  const refreshToken = acc?.refreshToken ?? null;
  if (!refreshToken) {
    logger.warn('No Google refresh token available', { accountId });
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
      logger.error('Google token refresh failed', { accountId, status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        updateGoogleAccount(accountId, { connected: false });
        broadcast({ type: 'google:disconnected', data: { slot: acc?.kind ?? 'agent' } } as never);
        // v2.3.19 — OAuth expiry is a true blocker. Critical.
        const label = acc?.kind === 'user' ? "user's" : "agent's";
        const who = acc?.email ? ` (${acc.email})` : '';
        try { sendAlert(`Google Workspace ${label} account${who} connection expired. Re-authenticate in Settings > Google.`, 'critical'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    const patch: Partial<Omit<GoogleAccount, 'id' | 'kind' | 'position'>> = {
      accessToken: data.access_token,
      tokenExpiresAt: Date.now() + data.expires_in * 1000,
    };
    if (data.refresh_token) patch.refreshToken = data.refresh_token;
    if (data.scope) patch.grantedScopes = data.scope;
    updateGoogleAccount(accountId, patch);
    logger.debug('Google access token refreshed', { accountId });
    return data.access_token;
  } catch (err) {
    logger.error('Google token refresh error', { accountId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── OAuth Flow ──

/**
 * What an OAuth flow is connecting into (Path B). Either a specific existing
 * account (reconnect, by id) or "add a new account to this kind" (accountId
 * undefined → after the exchange we dedupe by email and otherwise create a new
 * row, subject to the per-kind cap).
 */
export interface OAuthTarget { kind: AccountSlot; accountId?: string }

// In-flight OAuth flows, keyed by the state token (the authoritative identity
// for "which flow is this callback completing"). Each click of "Connect" /
// "Add another" starts an independent flow.
interface OAuthFlow { redirectUri: string; target: OAuthTarget; createdAt: number }
const oauthFlows = new Map<string, OAuthFlow>();
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export function getFlowForState(state: string): { redirectUri: string; target: OAuthTarget } | null {
  const flow = oauthFlows.get(state);
  return flow ? { redirectUri: flow.redirectUri, target: flow.target } : null;
}

/** Drop a completed/failed flow so its state token can't be replayed. */
export function clearOAuthFlow(state: string): void {
  oauthFlows.delete(state);
}

export function buildAuthUrl(redirectUri: string, target: OAuthTarget): { authUrl: string } {
  // Prune stale flows from abandoned attempts so the map can't grow unbounded.
  const now = Date.now();
  for (const [s, f] of oauthFlows) {
    if (now - f.createdAt > OAUTH_FLOW_TTL_MS) oauthFlows.delete(s);
  }

  const state = crypto.randomBytes(16).toString('hex');
  oauthFlows.set(state, { redirectUri, target, createdAt: now });

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

export async function exchangeCodeForTokens(code: string, redirectUri: string, target: OAuthTarget): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  const slot = target.kind;
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

    // Get email from userinfo (needed to dedupe / label the account).
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

    // Resolve which account row receives these tokens.
    let accountId: string;
    if (target.accountId) {
      // Reconnect a specific existing account.
      const acc = getGoogleAccount(target.accountId);
      if (!acc) return { success: false, error: 'That account no longer exists. Refresh Settings and try again.' };
      accountId = acc.id;
    } else {
      // "Add to kind": if this email is already an account of the kind, reconnect
      // it instead of duplicating; otherwise create a new row, subject to the cap.
      const existing = email
        ? listGoogleAccounts(slot).find(a => (a.email ?? '').toLowerCase() === email.toLowerCase())
        : null;
      if (existing) {
        accountId = existing.id;
      } else {
        if (countGoogleAccounts(slot) >= MAX_ACCOUNTS_PER_KIND) {
          return { success: false, error: `Limit of ${MAX_ACCOUNTS_PER_KIND} ${slot} Google accounts reached. Remove one before adding another.` };
        }
        const created = insertGoogleAccount({
          kind: slot,
          email,
          watchEmail: slot === 'agent',
          sendEmail: slot === 'agent',
        });
        accountId = created.id;
      }
    }

    updateGoogleAccount(accountId, {
      accessToken: data.access_token,
      tokenExpiresAt: Date.now() + data.expires_in * 1000,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(data.scope ? { grantedScopes: data.scope } : {}),
      email: email || undefined,
      connected: true,
      enabled: true,
      lastVerifiedAt: new Date().toISOString(),
    });
    broadcast({ type: 'google:connected', data: { email, slot } } as never);

    // Soft warning if the same email is connected as both an agent and a user
    // account. Not a hard refusal — legitimate reasons exist (testing, recovery)
    // — but log it as a breadcrumb for "why are agent and user the same" support.
    if (email) {
      const otherSlot: AccountSlot = slot === 'agent' ? 'user' : 'agent';
      const otherMatch = listGoogleAccounts(otherSlot).some(
        a => a.connected && (a.email ?? '').toLowerCase() === email.toLowerCase(),
      );
      if (otherMatch) {
        logger.warn('Google: same email connected as both agent and user', { slot, otherSlot, email });
      }
    }

    logger.info('Google Workspace connected', { slot, accountId, email });
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
    updateGoogleAccount(ensureSlotAccount(slot).id, { lastVerifiedAt: new Date().toISOString() });
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
  const acc = slotAccount(slot);
  if (acc) {
    // Clear connection, tokens, and per-account prefs but preserve the
    // watch/send toggles — the legacy disconnect never reset those.
    updateGoogleAccount(acc.id, {
      enabled: false,
      connected: false,
      email: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      lastVerifiedAt: null,
      enabledServices: null,
      grantedScopes: null,
    });
  }
  broadcast({ type: 'google:disconnected', data: { slot } } as never);
  logger.info('Google Workspace disconnected', { slot });
}

/**
 * Disconnect a SPECIFIC account by id. A non-primary account (position > 1) is
 * removed entirely so its slot frees up; the position-1 row is reset in place
 * (preserving watch/send) so the legacy slot mapping survives a reconnect.
 */
export function disconnectGoogleAccount(accountId: string): void {
  const acc = getGoogleAccount(accountId);
  if (!acc) return;
  if (acc.position === 1) {
    updateGoogleAccount(acc.id, {
      enabled: false, connected: false, email: null,
      accessToken: null, refreshToken: null, tokenExpiresAt: null,
      lastVerifiedAt: null, enabledServices: null, grantedScopes: null,
    });
  } else {
    deleteGoogleAccount(acc.id);
  }
  broadcast({ type: 'google:disconnected', data: { slot: acc.kind } } as never);
  logger.info('Google account disconnected', { accountId, kind: acc.kind, position: acc.position });
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
