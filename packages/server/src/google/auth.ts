// Google Workspace auth: native OAuth 2.0 with auto-refresh, mirroring the Microsoft auth.ts. Two slots:
// 'agent' (the agent's own identity, the default) and 'user' (the human's account); each resolves to its
// kind's lowest-position row in google_accounts (accounts.ts).

import crypto from 'node:crypto';
import { widestIntegrationLevel } from '../agent/access/read.js';
import {
  countGoogleAccounts,
  deleteGoogleAccount,
  getGoogleAccount,
  getPrimaryGoogleAccount,
  insertGoogleAccount,
  listGoogleAccounts,
  updateGoogleAccount, noteGoogleSignInExpired,
  MAX_ACCOUNTS_PER_KIND,
  type GoogleAccount,
} from './accounts.js';
import { createLogger } from '../logger.js';
import { classifyTokenRefreshFailure } from '../services/oauth-refresh-classify.js';

const logger = createLogger('google-auth');

// Google requires a client secret on code exchange and refresh for every client type a self-hosted app can
// use, so those two calls go through a Cornerpin broker (a Cloudflare Worker) that injects the secret and the
// app never holds it. PKCE is still used end to end. Both constants below are public, identical on every install.
const CLIENT_ID = '910593387780-mhtqug66aa0bf2m2bojknskvgolnqefe.apps.googleusercontent.com';

const AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
// Token endpoint is the broker (not Google); it adds the secret and forwards to oauth2.googleapis.com/token.
const TOKEN_URL = 'https://googleconnect.theagentdojo.com/';

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
  // Forms create/edit and read responses
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
].join(' ');

// Exported as an array so callers can compare it against a token's granted scopes.
export const REQUIRED_SCOPES: readonly string[] = SCOPES.split(' ');


export type AccountSlot = 'agent' | 'user';
export const ACCOUNT_SLOTS: readonly AccountSlot[] = ['agent', 'user'];

// The legacy slot ('agent'/'user') resolves to that kind's position-1 account row; slot and kind are
// identical, so a slot is passed straight through as a kind.

/**
 * Normalize scope ids to full URLs for set comparison: Google accepts "email" but tokeninfo reports
 * "https://www.googleapis.com/auth/userinfo.email", which a plain diff would show as missing.
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


/** The kind's position-1 account row, or null on a fresh (unconnected) install. */
function slotAccount(slot: AccountSlot): GoogleAccount | null {
  return getPrimaryGoogleAccount(slot);
}

/**
 * The kind's position-1 row, created on demand for setters with the kind defaults (agent watch/send ON,
 * user OFF); id == kind keeps it addressable as the legacy slot.
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

// A kind's tools are offered if ANY of its connected accounts has the service enabled, not just position 1.

export function isAnyGoogleAccountConnected(slot: AccountSlot): boolean {
  return listGoogleAccounts(slot).some(a => a.connected);
}

export function isGoogleServiceEnabledForKind(
  slot: AccountSlot,
  service: keyof GoogleWorkspaceConfig['enabledServices'],
): boolean {
  return listGoogleAccounts(slot).some(a => a.connected && parseServices(a.enabledServices)[service]);
}

/**
 * Every service-enabled flag for a kind from ONE account-list read (getFilteredTools asks per tool). Same
 * fact door as isGoogleServiceEnabledForKind (listGoogleAccounts + parseServices), so results are identical.
 */
export function getGoogleServiceFlagsForKind(
  slot: AccountSlot,
): Record<keyof GoogleWorkspaceConfig['enabledServices'], boolean> {
  const connected = listGoogleAccounts(slot).filter(a => a.connected);
  const flags = {} as Record<keyof GoogleWorkspaceConfig['enabledServices'], boolean>;
  for (const service of Object.keys(DEFAULT_SERVICES) as Array<keyof GoogleWorkspaceConfig['enabledServices']>) {
    flags[service] = connected.some(a => parseServices(a.enabledServices)[service]);
  }
  return flags;
}


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

/** Sanitized per-account view for the dashboard, never includes tokens. */
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
 * Whether the Gmail watcher polls this slot's inbox and forwards notifications to the primary agent.
 * Defaults true for the agent slot, false for the user slot (a personal inbox needs an explicit opt-in).
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
 * Whether the agent may send/reply/forward email from this slot. Defaults true for the agent slot, false
 * for the user slot (connecting must not grant outbound permission). Send tools refuse naming the toggle.
 */
export function isEmailSendingEnabled(slot: AccountSlot = 'agent'): boolean {
  const acc = slotAccount(slot);
  if (acc) return acc.sendEmail;
  return slot === 'agent';
}

export function setEmailSendingEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateGoogleAccount(ensureSlotAccount(slot).id, { sendEmail: enabled });
}

export function setEnabledServices(services: Partial<GoogleWorkspaceConfig['enabledServices']>, slot: AccountSlot = 'agent'): void {
  const current = getEnabledServices(slot);
  updateGoogleAccount(ensureSlotAccount(slot).id, { enabledServices: JSON.stringify({ ...current, ...services }) });
}


/**
 * Scopes from REQUIRED_SCOPES the connected user has NOT granted (they connected before the list grew and
 * must re-consent). Empty when fully granted, or when the user is not connected at all.
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

/** Learn the granted scopes from Google's tokeninfo endpoint with the current access token, then persist them. */
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

// Per-ACCOUNT refresh mutex (keyed by account id): each connected account refreshes independently.
const refreshPromises: Map<string, Promise<string | null> | null> = new Map();

/** Valid access token for a specific account id, refreshing if needed (the slot wrapper delegates here). */
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

/**
 * Bench an account: mark it disconnected and, only on the connected -> benched transition, broadcast the
 * disconnect and note the expired sign-in. Gating on the prior state stops the recovery probe (which
 * refreshes already-benched accounts) from repeating it every cycle.
 */
function benchGoogleAccount(acc: GoogleAccount | null, accountId: string): void {
  const wasConnected = acc?.connected ?? false;
  updateGoogleAccount(accountId, { connected: false });
  if (!wasConnected) return; // already benched, nothing to repeat
  // No platform text for an expired sign-in: the dashboard card stays and the agent sees the disconnected
  // integration in its prompt.
  noteGoogleSignInExpired(accountId, expiredWords(acc));
}

const expiredWords = (acc: { kind?: string; email?: string | null } | null): string => `Google Workspace ${acc?.kind === 'user' ? "user's" : "agent's"} account${acc?.email ? ` (${acc.email})` : ''} connection expired. Re-authenticate in Settings → Channels (the Google cards).`; // the owner's card carries these words

async function refreshAccessTokenForAccount(accountId: string): Promise<string | null> {
  const acc = getGoogleAccount(accountId);
  const refreshToken = acc?.refreshToken ?? null;
  if (!refreshToken) {
    logger.warn('No Google refresh token available', { accountId });
    return null;
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  // No client secret here: the broker injects it server-side.

  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      const verdict = classifyTokenRefreshFailure(resp.status, err);
      if (verdict === 'terminal') {
        // Genuine dead-account signal (invalid_grant / interaction_required / consent_required /
        // login_required): bench the account.
        logger.error('Google token refresh failed (terminal, benching account)', { accountId, status: resp.status, error: err });
        benchGoogleAccount(acc, accountId);
      } else {
        // TRANSIENT (5xx, throttling, clock skew, an unrecognized 400): never bench a healthy account on a
        // passing hiccup. Keep connected=1; the caller's null return covers this call and the probe re-tests.
        logger.warn('Google token refresh failed (transient, leaving account connected)', { accountId, status: resp.status, error: err });
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
    // A network throw produced no HTTP response, so it is transient: never bench; return null for this call.
    logger.warn('Google token refresh error (transient, leaving account connected)', { accountId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}


/**
 * Benched accounts that still hold a refresh token, the recovery probe's candidates (without one only a
 * Settings re-auth can fix it).
 */
export function listReconnectableGoogleAccounts(): GoogleAccount[] {
  return listGoogleAccounts().filter(a => !a.connected && !!a.refreshToken);
}

/**
 * Recovery-probe step for ONE benched account: force a real token refresh and, if it works, un-bench it
 * (connected=1, lastVerifiedAt) and broadcast the reconnect. No owner ping for a silent self-heal. A failed
 * refresh was already handled by refreshAccessTokenForAccount (terminal: stays benched with no repeat
 * note; transient: left for the next cycle).
 */
export async function attemptGoogleReconnect(accountId: string): Promise<'reconnected' | 'still-down'> {
  const acc = getGoogleAccount(accountId);
  if (!acc || acc.connected || !acc.refreshToken) return 'still-down';
  const token = await refreshAccessTokenForAccount(accountId);
  if (!token) return 'still-down';
  updateGoogleAccount(accountId, { connected: true, lastVerifiedAt: new Date().toISOString() });
  logger.info('Google account reconnected on recovery probe', { accountId, slot: acc.kind, email: acc.email ?? null });
  return 'reconnected';
}


/**
 * What an OAuth flow connects into: a specific existing account (reconnect, by id) or, with accountId
 * undefined, a new account (deduped by email after the exchange, subject to the per-kind cap).
 */
export interface OAuthTarget { kind: AccountSlot; accountId?: string }

// PKCE (RFC 7636, S256): proves possession of the authorization request via a per-flow verifier.
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// In-flight OAuth flows keyed by the state token, which identifies the flow a callback completes. The PKCE
// verifier is held here across the redirect and consumed at code exchange.
interface OAuthFlow { verifier: string; redirectUri: string; target: OAuthTarget; createdAt: number }
const oauthFlows = new Map<string, OAuthFlow>();
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export function getFlowForState(state: string): { verifier: string; redirectUri: string; target: OAuthTarget } | null {
  const flow = oauthFlows.get(state);
  return flow ? { verifier: flow.verifier, redirectUri: flow.redirectUri, target: flow.target } : null;
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

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  oauthFlows.set(state, { verifier, redirectUri, target, createdAt: now });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  return { authUrl: `${AUTH_BASE}?${params.toString()}` };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string, target: OAuthTarget): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  const slot = target.kind;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  // No client secret here: the broker injects it server-side; PKCE secures the exchange.

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
      const acc = getGoogleAccount(target.accountId);
      if (!acc) return { success: false, error: 'That account no longer exists. Refresh Settings and try again.' };
      accountId = acc.id;
    } else {
      // Same email already an account of the kind: reconnect it; otherwise create a row (subject to the cap).
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

    // Soft warning if the same email is connected as both an agent and a user account (not a refusal:
    // testing and recovery are legitimate); logged as a breadcrumb for support.
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

export function disconnectGoogle(slot: AccountSlot = 'agent'): void {
  const acc = slotAccount(slot);
  if (acc) {
    // Clear connection, tokens and per-account prefs but preserve the watch/send toggles.
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
  logger.info('Google Workspace disconnected', { slot });
}

/**
 * Disconnect a SPECIFIC account by id. A non-primary account (position > 1) is removed so its slot frees
 * up; the position-1 row is reset in place (keeping watch/send) so the legacy slot mapping survives.
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
  logger.info('Google account disconnected', { accountId, kind: acc.kind, position: acc.position });
}


export function getAgentGoogleAccessLevel(agentId: string, isPrimary: boolean, _isPM: boolean): 'full' | 'read' | 'none' {
  // The tier is the agent's own grant. CONNECTIVITY still wins: an account that is not connected or a
  // provider that is disabled is `none` whatever the grant says, a fact about the box and not a permission.
  const anyEnabled = isGoogleEnabled('agent') || isGoogleEnabled('user');
  const anyConnected = isGoogleConnected('agent') || isGoogleConnected('user');
  if (!anyEnabled || !anyConnected) return 'none';
  // The main agent holds every account, whatever level is stored for it.
  return isPrimary ? 'full' : widestIntegrationLevel(agentId, 'google');
}
