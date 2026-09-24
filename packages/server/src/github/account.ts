// ════════════════════════════════════════════════════════════════════════════════════════
// THE USER'S GITHUB ACCOUNT — ONE SEALED ROW, AND THE ONLY DOOR TO IT (DOJO-REPORT T4).
//
// This module is the storage half of the GitHub connection and NOTHING ELSE: no OAuth, no
// polling, no HTTP. `device-flow.ts` layers the handshake on top of it, the way
// `google/auth.ts` layers refresh on top of `google/accounts.ts`.
//
// ── THE REFUSAL THIS MODULE EXISTS TO HOLD (RULING P5-R13, permanent) ──
// The token NEVER goes into `agent_credentials`. That store answers by NAME — `credential_get`
// hands any row's decrypted payload to any agent holding the credentials grant — and this
// token can open an issue on a public repository AS THE USER. So it is sealed in place, in a
// table no tool surface reads, through the one at-rest owner (`credentials/at-rest.ts`).
// `credentials/__tests__/secret-at-rest.test.ts` clause (4) censuses that claim over the whole
// server source rather than trusting this comment.
//
// ── THE SEAM, STATED THE WAY THE CENSUS WILL READ IT ──
// ONE write point for the token: `saveGithubAccount`, which seals. ONE read point:
// `getGithubToken`, which opens. Every other function in this file touches the bookkeeping
// columns and never the token — which is why they can be read at a glance and why adding a
// second write point is a visible act rather than an accident.
//
// ── THE LEDGER COLUMNS ARE NOT DECORATION ──
// `last_ok_at` / `last_error` exist because of the connection-truth-outranks-memory doctrine
// (`memory/integration-status-lane.ts`): the card must never show a freshness nobody measured.
// They record the LAST LIVE OUTCOME of a real GitHub call and nothing else. There is no timer
// here, no staleness heuristic, and no "probably still fine".
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { openSecretColumn, sealSecretColumn } from '../credentials/at-rest.js';

/**
 * The OAuth App's PUBLIC client id, set once by the owner. It lives here rather than in
 * `device-flow.ts` for one stated reason and one measured one: it is a STORED fact about this
 * box, which is what this module holds; and `device-flow.ts` was over `check-growth.mjs`'s
 * 240-line line with it inside, and the plan's answer to that is SPLIT, never pin.
 *
 * It is public by design — a device-flow client id is in every copy of this build already, and
 * there is no client secret to go with it. Null means "not set up yet", which every door
 * answers with a sentence and the card renders as a plain state rather than a broken button.
 */
export function githubClientId(): string | null {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'github_client_id'")
    .get() as { value: string } | undefined;
  const v = row?.value?.trim();
  return v ? v : null;
}

/** What the dashboard and the poster may know about the connection. NO TOKEN FIELD, ever. */
export interface GithubAccount {
  login: string | null;
  scope: string | null;
  connectedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

interface GithubAccountRow {
  login: string | null;
  access_token: string | null;
  scope: string | null;
  connected_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

/** The whole row, raw. Private on purpose: the token column leaves this module only
 *  through `getGithubToken`, and only opened. */
function readRow(): GithubAccountRow | null {
  const row = getDb().prepare(
    `SELECT login, access_token, scope, connected_at, last_ok_at, last_error
       FROM github_account WHERE id = 1`,
  ).get() as GithubAccountRow | undefined;
  return row ?? null;
}

/**
 * THE ONE WRITE POINT FOR THE TOKEN. An upsert on the single legal id, so reconnecting
 * REPLACES the account rather than accumulating rows (`CHECK (id = 1)` makes that structural,
 * not conventional). `last_error` is cleared here deliberately: a fresh grant is the newest
 * live outcome there is, and leaving a stale failure beside it would be the card lying.
 */
export function saveGithubAccount(login: string | null, accessToken: string, scope: string): void {
  getDb().prepare(
    `INSERT INTO github_account (id, login, access_token, scope, connected_at, last_ok_at, last_error, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'), datetime('now'), NULL, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       login = excluded.login, access_token = excluded.access_token, scope = excluded.scope,
       connected_at = excluded.connected_at, last_ok_at = excluded.last_ok_at,
       last_error = NULL, updated_at = datetime('now')`,
  ).run(login, sealSecretColumn(accessToken), scope);
}

/**
 * THE ONE READ POINT FOR THE TOKEN. Returns null when there is no row, when the column is
 * empty, or when the sealed value will not open — the last being what a rotated master key
 * looks like. `openSecretColumn` degrades rather than throwing (it logs the CALL SITE and
 * never the value), so a rotated key surfaces as "reconnect", never as a boot that dies.
 */
export function getGithubToken(): string | null {
  const row = readRow();
  if (!row) return null;
  const opened = openSecretColumn(row.access_token, 'github/account.getGithubToken');
  return opened === null || opened === '' ? null : opened;
}

/** The projection everything outside this module is allowed to see. */
export function getGithubAccount(): GithubAccount | null {
  const row = readRow();
  if (!row) return null;
  return {
    login: row.login,
    scope: row.scope,
    connectedAt: row.connected_at,
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
  };
}

/**
 * A real GitHub call just succeeded. This is the ONLY thing that may advance `last_ok_at` —
 * nothing schedules it, nothing infers it, and no timer touches it.
 */
export function noteGithubOk(): void {
  getDb().prepare(
    `UPDATE github_account SET last_ok_at = datetime('now'), last_error = NULL,
            updated_at = datetime('now') WHERE id = 1`,
  ).run();
}

/**
 * A real GitHub call just failed. The message is the platform's own sentence about the
 * outcome — a status code, a refusal — and it is shown to the owner verbatim, so it must
 * never carry a token or a user's content.
 */
export function noteGithubFailure(message: string): void {
  getDb().prepare(
    `UPDATE github_account SET last_error = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(message.slice(0, 500));
}

/**
 * Disconnect. The ROW GOES, not just the token: a box that disconnected GitHub should carry
 * no trace of whose account it was, and leaving a login behind with a null token is exactly
 * the half-state the reauth surface reads as "your connection broke", which would be a lie.
 */
export function disconnectGithub(): void {
  getDb().prepare('DELETE FROM github_account WHERE id = 1').run();
}
