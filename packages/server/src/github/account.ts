// Storage half of the GitHub connection: one sealed row, the only door to the token. No OAuth or HTTP here.
// The token never goes into `agent_credentials` (credential_get would hand it to any agent); it is sealed in
// place via `credentials/at-rest.ts`. One write point (`saveGithubAccount`), one read point (`getGithubToken`).

import { getDb } from '../db/connection.js';
import { openSecretColumn, sealSecretColumn } from '../credentials/at-rest.js';

// The client id is a public device-flow id (no secret), shipped as the floor; a `config.github_client_id` row
// overrides it so a fork can retarget. A null id is the 'unconfigured' card state.

export const GITHUB_OAUTH_CLIENT_ID_DEFAULT = 'Ov23liY4CDJARDeVZtXQ';

/** An override with content wins, else the shipped default; null only when both are blank. */
export function resolveGithubClientId(
  override: string | null | undefined,
  fallback: string = GITHUB_OAUTH_CLIENT_ID_DEFAULT,
): string | null {
  const o = override?.trim();
  if (o) return o;
  const f = fallback.trim();
  return f ? f : null;
}

/** The client id for this box. `string | null` stays so the not-configured paths remain live for forks. */
export function githubClientId(): string | null {
  const row = getDb().prepare("SELECT value FROM config WHERE key = 'github_client_id'")
    .get() as { value: string } | undefined;
  return resolveGithubClientId(row?.value);
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

/** The whole row, raw. Private: the token leaves this module only through `getGithubToken`. */
function readRow(): GithubAccountRow | null {
  const row = getDb().prepare(
    `SELECT login, access_token, scope, connected_at, last_ok_at, last_error
       FROM github_account WHERE id = 1`,
  ).get() as GithubAccountRow | undefined;
  return row ?? null;
}

/** The one write point for the token. Upserts the single legal id (`CHECK (id = 1)`) and clears `last_error`. */
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

/** The one read point. Null when absent or unopenable (a rotated master key degrades to 'reconnect'). */
export function getGithubToken(): string | null {
  const row = readRow();
  if (!row) return null;
  const opened = openSecretColumn(row.access_token, 'github/account.getGithubToken');
  return opened === null || opened === '' ? null : opened;
}

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

/** A real GitHub call succeeded. Only live outcomes move `last_ok_at`; no timer or heuristic may. */
export function noteGithubOk(): void {
  getDb().prepare(
    `UPDATE github_account SET last_ok_at = datetime('now'), last_error = NULL,
            updated_at = datetime('now') WHERE id = 1`,
  ).run();
}

/** Records a failed real GitHub call; shown to the owner verbatim, so never pass a token or user content. */
export function noteGithubFailure(message: string): void {
  getDb().prepare(
    `UPDATE github_account SET last_error = ?, updated_at = datetime('now') WHERE id = 1`,
  ).run(message.slice(0, 500));
}

/** Disconnect deletes the whole row, so no login lingers beside a null token. */
export function disconnectGithub(): void {
  getDb().prepare('DELETE FROM github_account WHERE id = 1').run();
}
