// ════════════════════════════════════════
// Microsoft 365 Auth — Public Client with PKCE
// Single registered app, no client secret, works for personal + work/school.
//
// Path B (multi-account): storage lives in the microsoft_accounts table via
// microsoft/accounts.ts. The legacy slot ('agent'/'user') resolves to that
// KIND's position-1 row; getters read it, setters create on demand. Token
// resolution is account-id-keyed. Mirrors google/auth.ts.
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { sendAlert } from '../services/imessage-bridge.js';
import {
  countMicrosoftAccounts,
  deleteMicrosoftAccount,
  getMicrosoftAccount,
  getPrimaryMicrosoftAccount,
  insertMicrosoftAccount,
  listMicrosoftAccounts,
  updateMicrosoftAccount,
  MAX_MS_ACCOUNTS_PER_KIND,
  type MicrosoftAccount,
  type MicrosoftAccountType,
} from './accounts.js';

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
    contacts: boolean;
    onenote: boolean;
    tasks: boolean;
  };
  lastVerifiedAt: string | null;
}

const DEFAULT_SERVICES = {
  outlook: true,
  calendar: true,
  onedrive: true,
  teams: true,
  contacts: true,
  onenote: true,
  tasks: true,
};

// ── Slot → account resolution ──

function slotAccount(slot: AccountSlot): MicrosoftAccount | null {
  return getPrimaryMicrosoftAccount(slot);
}

function ensureSlotAccount(slot: AccountSlot): MicrosoftAccount {
  const existing = getPrimaryMicrosoftAccount(slot);
  if (existing) return existing;
  return insertMicrosoftAccount({
    id: slot,
    kind: slot,
    position: 1,
    watchEmail: slot === 'agent',
    sendEmail: slot === 'agent',
  });
}

function parseServices(json: string | null): MicrosoftWorkspaceConfig['enabledServices'] {
  let services = { ...DEFAULT_SERVICES };
  if (json) {
    try { services = { ...DEFAULT_SERVICES, ...JSON.parse(json) }; } catch { /* defaults */ }
  }
  return services;
}

// ── Config Getters ──

export function getMicrosoftWorkspaceConfig(slot: AccountSlot = 'agent'): MicrosoftWorkspaceConfig {
  const acc = slotAccount(slot);
  return {
    enabled: acc?.enabled ?? false,
    connected: acc?.connected ?? false,
    accountEmail: acc?.email ?? null,
    accountType: acc?.accountType ?? null,
    enabledServices: parseServices(acc?.enabledServices ?? null),
    lastVerifiedAt: acc?.lastVerifiedAt ?? null,
  };
}

export function isMicrosoftEnabled(slot: AccountSlot = 'agent'): boolean { return slotAccount(slot)?.enabled ?? false; }
export function isMicrosoftConnected(slot: AccountSlot = 'agent'): boolean { return slotAccount(slot)?.connected ?? false; }
export function getEnabledMsServices(slot: AccountSlot = 'agent'): MicrosoftWorkspaceConfig['enabledServices'] { return getMicrosoftWorkspaceConfig(slot).enabledServices; }
export function getMsAccountType(slot: AccountSlot = 'agent'): 'msa' | 'entra' | null { return slotAccount(slot)?.accountType ?? null; }
export function getClientId(): string { return CLIENT_ID; }

// ── Kind-level aggregation (multi-account aware) ──

export function isAnyMicrosoftAccountConnected(slot: AccountSlot): boolean {
  return listMicrosoftAccounts(slot).some(a => a.connected);
}

export function isMsServiceEnabledForKind(
  slot: AccountSlot,
  service: keyof MicrosoftWorkspaceConfig['enabledServices'],
): boolean {
  return listMicrosoftAccounts(slot).some(a => a.connected && parseServices(a.enabledServices)[service]);
}

/**
 * FA-TS1: every service-enabled flag for a kind, computed from ONE account-list
 * read (mirrors getGoogleServiceFlagsForKind). Replaces ~76 per-tool
 * listMicrosoftAccounts scans in getFilteredTools with a single read per kind.
 * Same fact door (listMicrosoftAccounts + parseServices), byte-identical results.
 */
export function getMsServiceFlagsForKind(
  slot: AccountSlot,
): Record<keyof MicrosoftWorkspaceConfig['enabledServices'], boolean> {
  const connected = listMicrosoftAccounts(slot).filter(a => a.connected);
  const flags = {} as Record<keyof MicrosoftWorkspaceConfig['enabledServices'], boolean>;
  for (const service of Object.keys(DEFAULT_SERVICES) as Array<keyof MicrosoftWorkspaceConfig['enabledServices']>) {
    flags[service] = connected.some(a => parseServices(a.enabledServices)[service]);
  }
  return flags;
}

export function isMsEmailMonitoringEnabled(slot: AccountSlot = 'agent'): boolean {
  const acc = slotAccount(slot);
  if (acc) return acc.watchEmail;
  return slot === 'agent';
}

export function setMsEmailMonitoringEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateMicrosoftAccount(ensureSlotAccount(slot).id, { watchEmail: enabled });
}

export function isMsEmailSendingEnabled(slot: AccountSlot = 'agent'): boolean {
  const acc = slotAccount(slot);
  if (acc) return acc.sendEmail;
  return slot === 'agent';
}

export function setMsEmailSendingEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateMicrosoftAccount(ensureSlotAccount(slot).id, { sendEmail: enabled });
}

// ── Config Setters ──

export function setMicrosoftConnected(connected: boolean, email?: string, accountType?: 'msa' | 'entra', slot: AccountSlot = 'agent'): void {
  const patch: Partial<Omit<MicrosoftAccount, 'id' | 'kind' | 'position'>> = { connected };
  if (email) patch.email = email;
  if (accountType) patch.accountType = accountType;
  if (connected) patch.lastVerifiedAt = new Date().toISOString();
  updateMicrosoftAccount(ensureSlotAccount(slot).id, patch);
  if (connected) {
    broadcast({ type: 'microsoft:connected', data: { email: email ?? '', slot } });
  } else {
    broadcast({ type: 'microsoft:disconnected', data: { slot } });
  }
}

export function setMicrosoftEnabled(enabled: boolean, slot: AccountSlot = 'agent'): void {
  updateMicrosoftAccount(ensureSlotAccount(slot).id, { enabled });
}

export function setEnabledMsServices(services: Partial<MicrosoftWorkspaceConfig['enabledServices']>, slot: AccountSlot = 'agent'): void {
  const current = getEnabledMsServices(slot);
  updateMicrosoftAccount(ensureSlotAccount(slot).id, { enabledServices: JSON.stringify({ ...current, ...services }) });
}

// ── Per-account setters (dashboard manages individual accounts by id) ──

export function setEnabledMsServicesForAccount(accountId: string, services: Partial<MicrosoftWorkspaceConfig['enabledServices']>): void {
  const acc = getMicrosoftAccount(accountId);
  if (!acc) return;
  const current = parseServices(acc.enabledServices);
  updateMicrosoftAccount(accountId, { enabledServices: JSON.stringify({ ...current, ...services }) });
}

export function setMsEmailMonitoringEnabledForAccount(accountId: string, enabled: boolean): void {
  if (!getMicrosoftAccount(accountId)) return;
  updateMicrosoftAccount(accountId, { watchEmail: enabled });
}

export function setMsEmailSendingEnabledForAccount(accountId: string, enabled: boolean): void {
  if (!getMicrosoftAccount(accountId)) return;
  updateMicrosoftAccount(accountId, { sendEmail: enabled });
}

/** Sanitized per-account view for the dashboard — never includes tokens. */
export interface MicrosoftAccountView {
  id: string;
  kind: AccountSlot;
  position: number;
  email: string | null;
  accountType: 'msa' | 'entra' | null;
  enabled: boolean;
  connected: boolean;
  services: MicrosoftWorkspaceConfig['enabledServices'];
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerified: string | null;
}

export function listMicrosoftAccountViews(): MicrosoftAccountView[] {
  return listMicrosoftAccounts().map(a => ({
    id: a.id,
    kind: a.kind,
    position: a.position,
    email: a.email,
    accountType: a.accountType,
    enabled: a.enabled,
    connected: a.connected,
    services: parseServices(a.enabledServices),
    watchEmail: a.watchEmail,
    sendEmail: a.sendEmail,
    lastVerified: a.lastVerifiedAt,
  }));
}

// ── Token Management ──

export function getAccessToken(slot: AccountSlot = 'agent'): string | null { return slotAccount(slot)?.accessToken ?? null; }

const refreshPromises: Map<string, Promise<string | null> | null> = new Map();

export async function getValidAccessTokenForAccount(accountId: string): Promise<string | null> {
  const acc = getMicrosoftAccount(accountId);
  if (!acc) return null;
  if (acc.accessToken && Date.now() < (acc.tokenExpiresAt ?? 0) - 5 * 60 * 1000) return acc.accessToken;
  const existing = refreshPromises.get(accountId);
  if (existing) return existing;
  const promise = refreshAccessTokenForAccount(accountId).finally(() => { refreshPromises.set(accountId, null); });
  refreshPromises.set(accountId, promise);
  return promise;
}

export async function getValidAccessToken(slot: AccountSlot = 'agent'): Promise<string | null> {
  const acc = getPrimaryMicrosoftAccount(slot);
  if (!acc) return null;
  return getValidAccessTokenForAccount(acc.id);
}

async function refreshAccessTokenForAccount(accountId: string): Promise<string | null> {
  const acc = getMicrosoftAccount(accountId);
  const refreshToken = acc?.refreshToken ?? null;
  if (!refreshToken) { logger.warn('No refresh token', { accountId }); return null; }

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
      logger.error('Token refresh failed', { accountId, status: resp.status, error: err });
      if (resp.status === 400 || resp.status === 401) {
        updateMicrosoftAccount(accountId, { connected: false });
        broadcast({ type: 'microsoft:disconnected', data: { slot: acc?.kind ?? 'agent' } });
        const label = acc?.kind === 'user' ? "user's" : "agent's";
        const who = acc?.email ? ` (${acc.email})` : '';
        try { sendAlert(`Microsoft 365 ${label} account${who} connection expired. Re-authenticate in Settings > Microsoft.`, 'critical'); } catch {}
      }
      return null;
    }

    const data = await resp.json() as { access_token: string; refresh_token?: string; expires_in: number };
    const patch: Partial<Omit<MicrosoftAccount, 'id' | 'kind' | 'position'>> = {
      accessToken: data.access_token,
      tokenExpiresAt: Date.now() + data.expires_in * 1000,
    };
    if (data.refresh_token) patch.refreshToken = data.refresh_token;
    updateMicrosoftAccount(accountId, patch);
    return data.access_token;
  } catch (err) {
    logger.error('Token refresh error', { accountId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── PKCE ──

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── OAuth Flow ──

export interface OAuthTarget { kind: AccountSlot; accountId?: string }

interface OAuthFlow { verifier: string; redirectUri: string; target: OAuthTarget; createdAt: number }
const oauthFlows = new Map<string, OAuthFlow>();
const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export function getFlowForState(state: string): { verifier: string; redirectUri: string; target: OAuthTarget } | null {
  const flow = oauthFlows.get(state);
  return flow ? { verifier: flow.verifier, redirectUri: flow.redirectUri, target: flow.target } : null;
}

export function clearOAuthFlow(state: string): void {
  oauthFlows.delete(state);
}

export function buildAuthUrl(redirectUri: string, target: OAuthTarget): { authUrl: string; state: string } {
  const now = Date.now();
  for (const [s, f] of oauthFlows) {
    if (now - f.createdAt > OAUTH_FLOW_TTL_MS) oauthFlows.delete(s);
  }

  const { verifier, challenge } = generatePKCE();
  const stateToken = crypto.randomBytes(16).toString('hex');
  oauthFlows.set(stateToken, { verifier, redirectUri, target, createdAt: now });

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

  return { authUrl: `${AUTH_BASE}/authorize?${params.toString()}`, state: stateToken };
}

export async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string, target: OAuthTarget): Promise<{
  success: boolean;
  email?: string;
  accountType?: 'msa' | 'entra';
  error?: string;
}> {
  const slot = target.kind;
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

    // Detect account type from id_token
    let accountType: MicrosoftAccountType = 'entra';
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

    // Resolve which account row receives these tokens (reconnect / dedupe / create).
    let accountId: string;
    if (target.accountId) {
      const acc = getMicrosoftAccount(target.accountId);
      if (!acc) return { success: false, error: 'That account no longer exists. Refresh Settings and try again.' };
      accountId = acc.id;
    } else {
      const existing = email
        ? listMicrosoftAccounts(slot).find(a => (a.email ?? '').toLowerCase() === email.toLowerCase())
        : null;
      if (existing) {
        accountId = existing.id;
      } else {
        if (countMicrosoftAccounts(slot) >= MAX_MS_ACCOUNTS_PER_KIND) {
          return { success: false, error: `Limit of ${MAX_MS_ACCOUNTS_PER_KIND} ${slot} Microsoft accounts reached. Remove one before adding another.` };
        }
        const created = insertMicrosoftAccount({
          kind: slot,
          email,
          accountType,
          watchEmail: slot === 'agent',
          sendEmail: slot === 'agent',
          // Personal (msa) accounts can't use Teams — disable it up front.
          ...(accountType === 'msa' ? { enabledServices: JSON.stringify({ ...DEFAULT_SERVICES, teams: false }) } : {}),
        });
        accountId = created.id;
      }
    }

    updateMicrosoftAccount(accountId, {
      accessToken: data.access_token,
      tokenExpiresAt: Date.now() + data.expires_in * 1000,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      email: email || undefined,
      accountType,
      connected: true,
      enabled: true,
      lastVerifiedAt: new Date().toISOString(),
    });
    if (accountType === 'msa') setEnabledMsServicesForAccount(accountId, { teams: false });
    broadcast({ type: 'microsoft:connected', data: { email, slot } });

    // Same-email soft warning across kinds.
    if (email) {
      const otherSlot: AccountSlot = slot === 'agent' ? 'user' : 'agent';
      const otherMatch = listMicrosoftAccounts(otherSlot).some(
        a => a.connected && (a.email ?? '').toLowerCase() === email.toLowerCase(),
      );
      if (otherMatch) {
        logger.warn('Microsoft: same email connected as both agent and user', { slot, otherSlot, email });
      }
    }

    logger.info('Microsoft 365 connected', { slot, accountId, email, accountType });

    // Install Office document packages in the background (idempotent), once.
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

export async function testMicrosoftAuth(slot: AccountSlot = 'agent'): Promise<{ authenticated: boolean; email: string | null }> {
  const token = await getValidAccessToken(slot);
  if (!token) return { authenticated: false, email: null };
  try {
    const resp = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { authenticated: false, email: null };
    const me = await resp.json() as { mail?: string; userPrincipalName?: string };
    updateMicrosoftAccount(ensureSlotAccount(slot).id, { lastVerifiedAt: new Date().toISOString() });
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
  const acc = slotAccount(slot);
  if (acc) {
    updateMicrosoftAccount(acc.id, {
      enabled: false, connected: false, email: null, accountType: null,
      accessToken: null, refreshToken: null, tokenExpiresAt: null,
      lastVerifiedAt: null, enabledServices: null,
    });
  }
  broadcast({ type: 'microsoft:disconnected', data: { slot } });
  logger.info('Microsoft 365 disconnected', { slot });
}

export function disconnectMicrosoftAccount(accountId: string): void {
  const acc = getMicrosoftAccount(accountId);
  if (!acc) return;
  if (acc.position === 1) {
    updateMicrosoftAccount(acc.id, {
      enabled: false, connected: false, email: null, accountType: null,
      accessToken: null, refreshToken: null, tokenExpiresAt: null,
      lastVerifiedAt: null, enabledServices: null,
    });
  } else {
    deleteMicrosoftAccount(acc.id);
  }
  broadcast({ type: 'microsoft:disconnected', data: { slot: acc.kind } });
  logger.info('Microsoft account disconnected', { accountId, kind: acc.kind, position: acc.position });
}

// ── Access Level ──

export function getAgentMicrosoftAccessLevel(_agentId: string, isPrimary: boolean, isPM: boolean): 'full' | 'read' | 'none' {
  const anyEnabled = isMicrosoftEnabled('agent') || isMicrosoftEnabled('user');
  const anyConnected = isMicrosoftConnected('agent') || isMicrosoftConnected('user');
  if (!anyEnabled || !anyConnected) return 'none';
  if (isPM) return 'none';
  if (isPrimary) return 'full';
  return 'read';
}
