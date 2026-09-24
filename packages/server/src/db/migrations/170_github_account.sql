-- 170 (DOJO-REPORT T4): THE USER'S OWN GITHUB TOKEN GETS A SEALED ROW OF ITS OWN.
--
-- WHY ITS OWN TABLE AND NOT `agent_credentials`. RULING P5-R13, permanent: a platform OAuth
-- token never moves into the agent-reachable credential store. `credential_get` answers by
-- NAME with no per-agent predicate on the value, so a row placed there is readable by every
-- agent that holds the credentials grant — and this token can open an issue on a public
-- repository under the USER'S OWN GITHUB IDENTITY. `google_accounts` and `twilio_config`
-- already settled this shape: the platform's secrets are sealed in place, in tables no tool
-- surface reads. This is that, for one more provider.
--
-- WHY A ONE-ROW TABLE AND NOT A `config` KEY. Two reasons, and the first is the load-bearing
-- one. (a) `credentials/__tests__/secret-at-rest.test.ts` clause (4) censuses credential-shaped
-- TEXT COLUMNS DECLARED IN THIS CHAIN — it reads the migration files and demands a stated
-- disposition for every `%token%`/`%secret%`/`%password%` column it finds. A token hidden in
-- `config.value` is invisible to that census, which is precisely the seam the clause exists to
-- keep honest; declaring the column here is what makes the token VISIBLE to the house's own
-- accounting. (b) `config` is a flat key/value bag read by the platform-config cache and
-- returned wholesale by `getAllPlatformConfig()` to the dashboard. A sealed token has no
-- business travelling that path.
--
-- WHY `CHECK (id = 1)`. One box, one GitHub account. The column set carries no natural key —
-- a login can change, a token is rotated — so without the constraint the table's contract
-- would be "whichever row a reader happened to pick". Every reader is `WHERE id = 1` and the
-- one writer is an upsert on the same, so the CHECK is not defence-in-depth, it IS the
-- contract. (`google_accounts` is multi-row because Workspace is genuinely multi-account, up
-- to five per kind; GitHub here is not — D2 posts as the ONE user who connected.)
--
-- WHY NO CHECK ON `scope`. The legal scope lives exactly once, in `github/device-flow.ts` as
-- `GITHUB_OAUTH_SCOPE = 'public_repo'`, and the request that asks for it is the only place it
-- can be chosen. A CHECK here would be a second, staler copy — and it would be the wrong
-- instrument besides: this column records what GITHUB GRANTED, which is a fact to show the
-- owner honestly, not a value for the schema to refuse. A box whose stored scope is wider
-- than we asked is a box whose owner should SEE that, not one that fails to boot.
--
-- WHAT NULL MEANS, column by column. `login` NULL: connected, but `GET /user` did not answer
-- when we asked — the token still works, we just do not have a name to show. `access_token`
-- NULL: not connected (and the row may still exist, carrying the last error). `scope` NULL:
-- GitHub returned no scope string. `connected_at` NULL: never connected. `last_ok_at` NULL: no
-- GitHub call has succeeded since the row was written. `last_error` NULL: the last outcome was
-- not a failure — this column is a LEDGER of the last live outcome, which is the
-- connection-truth-outranks-memory doctrine (`memory/integration-status-lane.ts`), never an
-- invented freshness.
--
-- SAFE ON A LIVED-IN BODY BY CONSTRUCTION: `CREATE TABLE IF NOT EXISTS` on a name that appears
-- nowhere in the 172-file chain. No column is added to an existing table, no row is read,
-- written or deleted, nothing is backfilled. A stable box arrives with zero rows and is
-- correct: it has connected no GitHub account.
--
-- NEXT-RELEASE AUDIT NOTE: `github_account.access_token` has exactly ONE writer
-- (`packages/server/src/github/account.ts` → `saveGithubAccount`, through `sealSecretColumn`)
-- and exactly ONE reader (`packages/server/src/github/account.ts` → `getGithubToken`, through
-- `openSecretColumn`). The other columns are written by `saveGithubAccount`, `noteGithubOk`,
-- `noteGithubFailure` and `disconnectGithub`, and read by `getGithubAccount`. No agent-facing
-- surface reads any of them; `secret-at-rest.test.ts` clause (4) holds both facts as a census
-- over the whole server source.

CREATE TABLE IF NOT EXISTS github_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  login         TEXT,
  access_token  TEXT,
  scope         TEXT,
  connected_at  TEXT,
  last_ok_at    TEXT,
  last_error    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
