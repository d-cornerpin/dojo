-- Multi-account Workspace storage (Path B). A dojo may connect up to five
-- accounts of each KIND for each provider: agent-kind (the agent's own
-- identities) and user-kind (the human's accounts). The kind is the
-- permission boundary — writes are primary-only, and user-kind send/watch
-- is opt-in per account — exactly as the 'agent'/'user' slot prefix meant
-- before, now scaled past two.
--
-- These tables REPLACE the per-key config storage (gws_*/gws_user_* and
-- ms_*/ms_user_*).
-- They are created additively here; the existing config keys are copied into
-- position-1 rows by a one-time programmatic seed (seedWorkspaceAccounts),
-- which reuses the current getter logic so boolean defaults (agent watch/send
-- default true, user default false) are preserved exactly. The legacy keys
-- are left in place during the transition so the old path keeps working and
-- rollback is trivial.
--
-- id is 'agent'/'user' for the migrated position-1 rows (so the slot->account
-- mapping during transition is identity) and a uuid for accounts added later.
-- UNIQUE(kind, position) keeps the per-kind ordering stable for the dashboard
-- list; the <=5 cap is enforced at the add-account endpoint, not the schema.

CREATE TABLE IF NOT EXISTS google_accounts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK(kind IN ('agent','user')),
  position         INTEGER NOT NULL,
  email            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  connected        INTEGER NOT NULL DEFAULT 0,
  access_token     TEXT,
  refresh_token    TEXT,
  token_expires_at INTEGER,
  granted_scopes   TEXT,
  enabled_services TEXT,                         -- JSON; NULL means provider defaults
  watch_email      INTEGER NOT NULL DEFAULT 0,
  send_email       INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS microsoft_accounts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK(kind IN ('agent','user')),
  position         INTEGER NOT NULL,
  email            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  connected        INTEGER NOT NULL DEFAULT 0,
  access_token     TEXT,
  refresh_token    TEXT,
  token_expires_at INTEGER,
  granted_scopes   TEXT,
  enabled_services TEXT,                         -- JSON; NULL means provider defaults
  watch_email      INTEGER NOT NULL DEFAULT 0,
  send_email       INTEGER NOT NULL DEFAULT 0,
  last_verified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_accounts_kind_pos
  ON google_accounts (kind, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_microsoft_accounts_kind_pos
  ON microsoft_accounts (kind, position);
