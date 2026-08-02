// ════════════════════════════════════════
// Microsoft account registry (Path B) — mirrors google/accounts.ts.
//
// Up to five accounts per KIND ('agent' / 'user') in microsoft_accounts. KIND
// is the permission boundary. Pure storage — no OAuth, no token refresh. MS
// carries an extra account_type ('msa' personal vs 'entra' work/school).
//
// seedMicrosoftAccountsFromConfig() bridges the legacy ms_* / ms_user_* keys
// into position-1 rows, preserving the old getter defaults (agent watch/send
// default ON, user OFF; services default all-on).
// ════════════════════════════════════════

import crypto from 'node:crypto';
import { getDb } from '../db/connection.js';
import { patchAssignments } from '../db/patch.js';
import { createLogger } from '../logger.js';
import { bumpToolConfigGeneration } from '../agent/tool-config-generation.js';

const logger = createLogger('microsoft-accounts');

export const MAX_MS_ACCOUNTS_PER_KIND = 5;

export type MicrosoftAccountKind = 'agent' | 'user';
export type MicrosoftAccountType = 'msa' | 'entra';

export interface MicrosoftAccount {
  id: string;
  kind: MicrosoftAccountKind;
  position: number;
  email: string | null;
  accountType: MicrosoftAccountType | null;
  enabled: boolean;
  connected: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  grantedScopes: string | null;
  enabledServices: string | null;
  watchEmail: boolean;
  sendEmail: boolean;
  lastVerifiedAt: string | null;
}

interface MicrosoftAccountRow {
  id: string;
  kind: MicrosoftAccountKind;
  position: number;
  email: string | null;
  account_type: MicrosoftAccountType | null;
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

function rowToAccount(r: MicrosoftAccountRow): MicrosoftAccount {
  return {
    id: r.id,
    kind: r.kind,
    position: r.position,
    email: r.email,
    accountType: r.account_type,
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

// FA-TS1 diagnostics: mirrors google/accounts.ts: count microsoft_accounts
// scans to verify the per-tool scan collapse from dev. Reset between measures.
let microsoftAccountScanCount = 0;
export function __getMicrosoftAccountScanCount(): number { return microsoftAccountScanCount; }
export function __resetMicrosoftAccountScanCount(): void { microsoftAccountScanCount = 0; }

export function listMicrosoftAccounts(kind?: MicrosoftAccountKind): MicrosoftAccount[] {
  microsoftAccountScanCount++;
  const db = getDb();
  const rows = (kind
    ? db.prepare('SELECT * FROM microsoft_accounts WHERE kind = ? ORDER BY position').all(kind)
    : db.prepare("SELECT * FROM microsoft_accounts ORDER BY kind = 'user', position").all()
  ) as MicrosoftAccountRow[];
  return rows.map(rowToAccount);
}

export function getMicrosoftAccount(id: string): MicrosoftAccount | null {
  const row = getDb().prepare('SELECT * FROM microsoft_accounts WHERE id = ?').get(id) as MicrosoftAccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

export function getPrimaryMicrosoftAccount(kind: MicrosoftAccountKind): MicrosoftAccount | null {
  const row = getDb()
    .prepare('SELECT * FROM microsoft_accounts WHERE kind = ? ORDER BY position LIMIT 1')
    .get(kind) as MicrosoftAccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

export function resolveMicrosoftAccount(kind: MicrosoftAccountKind, email?: string | null): MicrosoftAccount | null {
  const accounts = listMicrosoftAccounts(kind);
  if (email) {
    const norm = email.trim().toLowerCase();
    return accounts.find(a => (a.email ?? '').toLowerCase() === norm) ?? null;
  }
  const connected = accounts.filter(a => a.connected);
  if (connected.length === 1) return connected[0];
  if (connected.length === 0 && accounts.length === 1) return accounts[0];
  return null;
}

export function resolveMicrosoftAccountForTool(
  kind: MicrosoftAccountKind,
  email?: string | null,
): { account: MicrosoftAccount } | { error: string } {
  const account = resolveMicrosoftAccount(kind, email);
  // FA-TS5: mirror google/accounts.ts. resolveMicrosoftAccount hands back a lone
  // DISCONNECTED account via its single-account back-compat branch. The tool-facing
  // resolver is authoritative on `.connected`; a disconnected-only resolution is
  // not a success (avoids a confusing auth failure or a run against stale tokens).
  if (account && account.connected) return { account };
  const connected = listMicrosoftAccounts(kind).filter(a => a.connected);
  if (connected.length === 0) {
    return { error: `No ${kind} Microsoft account is connected. Connect one in Settings → Microsoft.` };
  }
  const emails = connected.map(a => a.email ?? a.id).join(', ');
  if (email) {
    return { error: `No connected ${kind} Microsoft account matches "${email}". Available: ${emails}.` };
  }
  return { error: `More than one ${kind} Microsoft account is connected — say which with the \`account\` parameter. Available: ${emails}.` };
}

/** Read-side resolution of a slot's account. */
export interface MicrosoftReadResolution {
  account: MicrosoftAccount;
  /** True when this slot has more than one CONNECTED account, so a narrow read
   *  result should name the account it read (self-describing header). */
  labelAccount: boolean;
}

/**
 * READ-only account resolver. Mirrors google/accounts.ts resolveGoogleAccountForRead.
 * Diverges from resolveMicrosoftAccountForTool on ONE case, by owner decision
 * (2026-07-08, correctness-floor): when a slot has more than one connected
 * account and the caller named none, a READ must NOT bounce with an
 * ask-which-account error (a wasted round trip for a pure lookup). Instead it
 * defaults to the slot's PRIMARY (lowest-position) connected account and flags
 * `labelAccount` so the caller labels the result with that account's address;
 * the F4 coverage floor surfaces the other accounts in the "also checked" block.
 *
 * The WRITE side deliberately keeps the ambiguity error (resolveMicrosoftAccountForTool):
 * ask-which-account before mutating the wrong mailbox/calendar is intentional and
 * is the subject of a separate open owner decision. Do NOT fold the two.
 */
export function resolveMicrosoftAccountForRead(
  kind: MicrosoftAccountKind,
  email?: string | null,
): MicrosoftReadResolution | { error: string } {
  const connected = listMicrosoftAccounts(kind).filter(a => a.connected);
  if (email) {
    // Named account: reuse the strict resolver so a bad/unmatched email still errors.
    const strict = resolveMicrosoftAccountForTool(kind, email);
    if ('error' in strict) return strict;
    return { account: strict.account, labelAccount: connected.length > 1 };
  }
  if (connected.length === 0) {
    // No connected account — reuse the strict resolver's not-connected error.
    return resolveMicrosoftAccountForTool(kind, email) as { error: string };
  }
  if (connected.length === 1) {
    return { account: connected[0], labelAccount: false };
  }
  // >1 connected, none named: default to the lowest-position connected account
  // (= position-1/primary when it is connected) and label it.
  return { account: connected[0], labelAccount: true };
}

export function countMicrosoftAccounts(kind: MicrosoftAccountKind): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM microsoft_accounts WHERE kind = ?').get(kind) as { n: number };
  return r.n;
}

// ── Writes ──

export interface NewMicrosoftAccount {
  kind: MicrosoftAccountKind;
  email?: string | null;
  accountType?: MicrosoftAccountType | null;
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
  id?: string;
  position?: number;
}

export function insertMicrosoftAccount(acc: NewMicrosoftAccount): MicrosoftAccount {
  const db = getDb();
  if (countMicrosoftAccounts(acc.kind) >= MAX_MS_ACCOUNTS_PER_KIND) {
    throw new Error(`Cannot add another ${acc.kind} Microsoft account: limit of ${MAX_MS_ACCOUNTS_PER_KIND} reached.`);
  }
  const position = acc.position ?? nextPosition(acc.kind);
  const id = acc.id ?? crypto.randomUUID();
  db.prepare(`
    INSERT INTO microsoft_accounts
      (id, kind, position, email, account_type, enabled, connected, access_token, refresh_token,
       token_expires_at, granted_scopes, enabled_services, watch_email, send_email, last_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, acc.kind, position, acc.email ?? null, acc.accountType ?? null,
    acc.enabled === false ? 0 : 1,
    acc.connected ? 1 : 0,
    acc.accessToken ?? null, acc.refreshToken ?? null, acc.tokenExpiresAt ?? null,
    acc.grantedScopes ?? null, acc.enabledServices ?? null,
    acc.watchEmail ? 1 : 0, acc.sendEmail ? 1 : 0, acc.lastVerifiedAt ?? null,
  );
  bumpToolConfigGeneration(); // FA-TS1: connect/add widens the tool surface
  return getMicrosoftAccount(id)!;
}

function nextPosition(kind: MicrosoftAccountKind): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM microsoft_accounts WHERE kind = ?')
    .get(kind) as { m: number };
  return r.m + 1;
}

const COLUMN: Record<string, string> = {
  email: 'email', accountType: 'account_type', enabled: 'enabled', connected: 'connected',
  accessToken: 'access_token', refreshToken: 'refresh_token',
  tokenExpiresAt: 'token_expires_at', grantedScopes: 'granted_scopes',
  enabledServices: 'enabled_services', watchEmail: 'watch_email',
  sendEmail: 'send_email', lastVerifiedAt: 'last_verified_at',
};
/** M7 (PHASE-4 T5): the `?? null` that used to sit in each text encoder WAS P527 —
 *  `email: email || undefined` from a reconnect whose /me lookup failed meant "leave it
 *  alone" and arrived as SQL NULL. `db/patch.ts` drops undefined before any encoder runs,
 *  so the defence is deleted rather than left standing where it can never fire. P527's own
 *  text asked for exactly this generalization: "Same mechanism applies to any future
 *  undefined-valued key in a patch." */
const ENCODE: Record<string, (v: unknown) => unknown> = {
  email: v => v, accountType: v => v,
  enabled: v => (v ? 1 : 0), connected: v => (v ? 1 : 0),
  accessToken: v => v, refreshToken: v => v,
  tokenExpiresAt: v => v, grantedScopes: v => v,
  enabledServices: v => v, watchEmail: v => (v ? 1 : 0),
  sendEmail: v => (v ? 1 : 0), lastVerifiedAt: v => v,
};

export function updateMicrosoftAccount(id: string, patch: Partial<Omit<MicrosoftAccount, 'id' | 'kind' | 'position'>>): void {
  const { sets, values } = patchAssignments(patch, {
    column: key => (ENCODE[key] ? COLUMN[key] : undefined),
    encode: (key, value) => ENCODE[key](value),
  });
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE microsoft_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  bumpToolConfigGeneration(); // FA-TS1: connected flag / enabledServices edits change the surface
}

export function deleteMicrosoftAccount(id: string): void {
  getDb().prepare('DELETE FROM microsoft_accounts WHERE id = ?').run(id);
  bumpToolConfigGeneration(); // FA-TS1: removing an account narrows the surface
}

// ── One-time seed from legacy config keys ──

function cfg(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function seedMicrosoftAccountsFromConfig(): void {
  for (const kind of ['agent', 'user'] as const) {
    if (getPrimaryMicrosoftAccount(kind)) continue;
    const p = kind === 'agent' ? 'ms_' : 'ms_user_';
    const accessToken = cfg(`${p}access_token`);
    const refreshToken = cfg(`${p}refresh_token`);
    const connected = cfg(`${p}connected`) === 'true';
    const email = cfg(`${p}account_email`);
    if (!accessToken && !refreshToken && !connected && !email) continue;

    const watchRaw = cfg(`${p}watch_email`);
    const sendRaw = cfg(`${p}send_email`);
    const expRaw = cfg(`${p}token_expires_at`);

    insertMicrosoftAccount({
      id: kind,
      kind,
      position: 1,
      email,
      accountType: (cfg(`${p}account_type`) as MicrosoftAccountType | null) ?? null,
      enabled: cfg(`${p}enabled`) === 'true',
      connected,
      accessToken,
      refreshToken,
      tokenExpiresAt: expRaw ? parseInt(expRaw, 10) : null,
      grantedScopes: cfg(`${p}granted_scopes`),
      enabledServices: cfg(`${p}enabled_services`),
      watchEmail: watchRaw !== null ? watchRaw === 'true' : kind === 'agent',
      sendEmail: sendRaw !== null ? sendRaw === 'true' : kind === 'agent',
      lastVerifiedAt: cfg(`${p}last_verified_at`),
    });
    logger.info('Seeded Microsoft account from legacy config', { kind, email: email ?? null, connected });
  }
}
