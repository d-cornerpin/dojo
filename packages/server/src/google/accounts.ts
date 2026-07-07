// ════════════════════════════════════════
// Google account registry (Path B, layer 1)
//
// The data layer for multi-account Google Workspace. Up to five accounts per
// KIND ('agent' = the agent's own identities; 'user' = the human's accounts),
// stored in the google_accounts table. KIND is the permission boundary: write
// tools are primary-only, and user-kind send/watch is opt-in per account.
//
// This module is pure storage — no OAuth, no token refresh, no tool wiring.
// auth.ts layers token refresh and the slot API on top of it (layer 2).
//
// seedGoogleAccountsFromConfig() is the one-time, idempotent bridge from the
// legacy per-key config storage (gws_* / gws_user_*) to position-1 rows. It
// reproduces the exact boolean-default rules the old getters used so a
// migrating install sees no behavior change: agent watch/send default ON,
// user watch/send default OFF, services default all-on.
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

const logger = createLogger('google-accounts');

export const MAX_ACCOUNTS_PER_KIND = 5;

export type GoogleAccountKind = 'agent' | 'user';

export interface GoogleAccount {
  id: string;
  kind: GoogleAccountKind;
  position: number;
  email: string | null;
  enabled: boolean;
  connected: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  grantedScopes: string | null;
  /** JSON string of the per-account service toggles; null means provider defaults. */
  enabledServices: string | null;
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerifiedAt: string | null;
}

interface GoogleAccountRow {
  id: string;
  kind: GoogleAccountKind;
  position: number;
  email: string | null;
  enabled: number;
  connected: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  granted_scopes: string | null;
  enabled_services: string | null;
  watch_email: number;
  send_email: number;
  last_verified_at: string | null;
}

function rowToAccount(r: GoogleAccountRow): GoogleAccount {
  return {
    id: r.id,
    kind: r.kind,
    position: r.position,
    email: r.email,
    enabled: r.enabled === 1,
    connected: r.connected === 1,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    tokenExpiresAt: r.token_expires_at,
    grantedScopes: r.granted_scopes,
    enabledServices: r.enabled_services,
    watchEmail: r.watch_email === 1,
    sendEmail: r.send_email === 1,
    lastVerifiedAt: r.last_verified_at,
  };
}

// ── Reads ──

// FA-TS1 diagnostics: count google_accounts scans so the perf fix can be
// verified from dev. Before the fix a multi-tool turn drove ~185 scans per
// callModel; after tier 1 + the memo a whole turn should show a small constant.
// Zero cost in the hot path (an integer increment); read via the exported
// getter from a dev route or REPL, reset between measurements.
let googleAccountScanCount = 0;
export function __getGoogleAccountScanCount(): number { return googleAccountScanCount; }
export function __resetGoogleAccountScanCount(): void { googleAccountScanCount = 0; }

export function listGoogleAccounts(kind?: GoogleAccountKind): GoogleAccount[] {
  googleAccountScanCount++;
  const db = getDb();
  const rows = (kind
    ? db.prepare('SELECT * FROM google_accounts WHERE kind = ? ORDER BY position').all(kind)
    : db.prepare("SELECT * FROM google_accounts ORDER BY kind = 'user', position").all()
  ) as GoogleAccountRow[];
  return rows.map(rowToAccount);
}

export function getGoogleAccount(id: string): GoogleAccount | null {
  const row = getDb().prepare('SELECT * FROM google_accounts WHERE id = ?').get(id) as GoogleAccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

/** The position-1 account for a kind — the back-compat target for the legacy
 *  slot API, where slot 'agent'/'user' resolves to that kind's first account. */
export function getPrimaryGoogleAccount(kind: GoogleAccountKind): GoogleAccount | null {
  const row = getDb()
    .prepare('SELECT * FROM google_accounts WHERE kind = ? ORDER BY position LIMIT 1')
    .get(kind) as GoogleAccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

/** Resolve a kind's account by email (the tool `account` param). When no email
 *  is given, defaults to the sole connected account; null if none or ambiguous. */
export function resolveGoogleAccount(kind: GoogleAccountKind, email?: string | null): GoogleAccount | null {
  const accounts = listGoogleAccounts(kind);
  if (email) {
    const norm = email.trim().toLowerCase();
    return accounts.find(a => (a.email ?? '').toLowerCase() === norm) ?? null;
  }
  const connected = accounts.filter(a => a.connected);
  if (connected.length === 1) return connected[0];
  if (connected.length === 0 && accounts.length === 1) return accounts[0];
  return null; // none connected, or more than one — caller must disambiguate
}

/** Tool-facing resolver: returns the chosen account or a ready-to-surface error
 *  string naming the connected accounts of this kind. */
export function resolveGoogleAccountForTool(
  kind: GoogleAccountKind,
  email?: string | null,
): { account: GoogleAccount } | { error: string } {
  const account = resolveGoogleAccount(kind, email);
  // FA-TS5: resolveGoogleAccount hands back a lone DISCONNECTED account via its
  // single-account back-compat branch. Running a tool against it dead-ends in a
  // confusing auth failure or, worse, succeeds against a stale refresh_token that
  // disconnect-on-refresh-failure cleared `connected` on but never wiped. The
  // tool-facing resolver is authoritative on `.connected`: only a genuinely
  // connected account counts as resolved.
  if (account && account.connected) return { account };
  const connected = listGoogleAccounts(kind).filter(a => a.connected);
  if (connected.length === 0) {
    return { error: `No ${kind} Google account is connected. Connect one in Settings → Google.` };
  }
  const emails = connected.map(a => a.email ?? a.id).join(', ');
  if (email) {
    return { error: `No connected ${kind} Google account matches "${email}". Available: ${emails}.` };
  }
  return { error: `More than one ${kind} Google account is connected — say which with the \`account\` parameter. Available: ${emails}.` };
}

export function countGoogleAccounts(kind: GoogleAccountKind): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM google_accounts WHERE kind = ?').get(kind) as { n: number };
  return r.n;
}

// ── Writes ──

export interface NewGoogleAccount {
  kind: GoogleAccountKind;
  email?: string | null;
  enabled?: boolean;
  connected?: boolean;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: number | null;
  grantedScopes?: string | null;
  enabledServices?: string | null;
  watchEmail?: boolean;
  sendEmail?: boolean;
  lastVerifiedAt?: string | null;
  /** Override the generated id — used by the seed to set the position-1 row id
   *  to the kind name ('agent'/'user') so the legacy slot maps by identity. */
  id?: string;
  /** Override position — defaults to next free slot for the kind. */
  position?: number;
}

/** Insert a new account for a kind. Throws if the kind is already at the cap. */
export function insertGoogleAccount(acc: NewGoogleAccount): GoogleAccount {
  const db = getDb();
  if (countGoogleAccounts(acc.kind) >= MAX_ACCOUNTS_PER_KIND) {
    throw new Error(`Cannot add another ${acc.kind} Google account: limit of ${MAX_ACCOUNTS_PER_KIND} reached.`);
  }
  const position = acc.position ?? nextPosition(acc.kind);
  const id = acc.id ?? crypto.randomUUID();
  db.prepare(`
    INSERT INTO google_accounts
      (id, kind, position, email, enabled, connected, access_token, refresh_token,
       token_expires_at, granted_scopes, enabled_services, watch_email, send_email, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, acc.kind, position, acc.email ?? null,
    acc.enabled === false ? 0 : 1,
    acc.connected ? 1 : 0,
    acc.accessToken ?? null, acc.refreshToken ?? null, acc.tokenExpiresAt ?? null,
    acc.grantedScopes ?? null, acc.enabledServices ?? null,
    acc.watchEmail ? 1 : 0, acc.sendEmail ? 1 : 0, acc.lastVerifiedAt ?? null,
  );
  bumpToolConfigGeneration(); // FA-TS1: connect/add widens the tool surface
  return getGoogleAccount(id)!;
}

function nextPosition(kind: GoogleAccountKind): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM google_accounts WHERE kind = ?')
    .get(kind) as { m: number };
  return r.m + 1;
}

/** Column map for partial updates — keeps updateGoogleAccount honest against
 *  the schema and applies the same boolean encoding everywhere. */
const UPDATABLE: Record<string, (v: unknown) => unknown> = {
  email: v => v ?? null,
  enabled: v => (v ? 1 : 0),
  connected: v => (v ? 1 : 0),
  accessToken: v => v ?? null,
  refreshToken: v => v ?? null,
  tokenExpiresAt: v => v ?? null,
  grantedScopes: v => v ?? null,
  enabledServices: v => v ?? null,
  watchEmail: v => (v ? 1 : 0),
  sendEmail: v => (v ? 1 : 0),
  lastVerifiedAt: v => v ?? null,
};

const COLUMN: Record<string, string> = {
  email: 'email', enabled: 'enabled', connected: 'connected',
  accessToken: 'access_token', refreshToken: 'refresh_token',
  tokenExpiresAt: 'token_expires_at', grantedScopes: 'granted_scopes',
  enabledServices: 'enabled_services', watchEmail: 'watch_email',
  sendEmail: 'send_email', lastVerifiedAt: 'last_verified_at',
};

export function updateGoogleAccount(id: string, patch: Partial<Omit<GoogleAccount, 'id' | 'kind' | 'position'>>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const col = COLUMN[key];
    const enc = UPDATABLE[key];
    if (!col || !enc) continue;
    sets.push(`${col} = ?`);
    values.push(enc(raw));
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE google_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  bumpToolConfigGeneration(); // FA-TS1: connected flag / enabledServices edits change the surface
}

export function deleteGoogleAccount(id: string): void {
  getDb().prepare('DELETE FROM google_accounts WHERE id = ?').run(id);
  bumpToolConfigGeneration(); // FA-TS1: removing an account narrows the surface
}

// ── One-time seed from legacy config keys ──

/** Read a legacy config value (raw string) or null. */
function cfg(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Idempotently copy the legacy gws_* (agent) and gws_user_* (user) keys into
 * position-1 rows. Runs at startup. Only seeds a kind that has NO rows yet AND
 * shows evidence of a prior connection (tokens or a connected flag), so fresh
 * installs don't get empty rows. The legacy keys are left untouched.
 */
export function seedGoogleAccountsFromConfig(): void {
  for (const kind of ['agent', 'user'] as const) {
    if (getPrimaryGoogleAccount(kind)) continue; // already seeded
    const p = kind === 'agent' ? 'gws_' : 'gws_user_';
    const accessToken = cfg(`${p}access_token`);
    const refreshToken = cfg(`${p}refresh_token`);
    const connected = cfg(`${p}connected`) === 'true';
    const email = cfg(`${p}account_email`);
    // Evidence of a prior connection — otherwise skip (nothing to migrate).
    if (!accessToken && !refreshToken && !connected && !email) continue;

    const watchRaw = cfg(`${p}watch_email`);
    const sendRaw = cfg(`${p}send_email`);
    const expRaw = cfg(`${p}token_expires_at`);

    insertGoogleAccount({
      id: kind,            // position-1 row id == kind, so legacy slot maps by identity
      kind,
      position: 1,
      email,
      enabled: cfg(`${p}enabled`) === 'true',
      connected,
      accessToken,
      refreshToken,
      tokenExpiresAt: expRaw ? parseInt(expRaw, 10) : null,
      grantedScopes: cfg(`${p}granted_scopes`),
      enabledServices: cfg(`${p}enabled_services`), // null => provider defaults
      // Preserve the old getter defaults: agent watch/send default ON, user OFF.
      watchEmail: watchRaw !== null ? watchRaw === 'true' : kind === 'agent',
      sendEmail: sendRaw !== null ? sendRaw === 'true' : kind === 'agent',
      lastVerifiedAt: cfg(`${p}last_verified_at`),
    });
    logger.info('Seeded Google account from legacy config', { kind, email: email ?? null, connected });
  }
}
