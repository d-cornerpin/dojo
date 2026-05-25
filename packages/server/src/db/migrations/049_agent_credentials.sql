-- v2.7.21: Agent credentials store.
--
-- A dedicated table for credentials that agents need to call third-party
-- APIs from within techniques. Separate from the vault entries table
-- (which is built for knowledge that decays over time) and from
-- secrets.yaml (which is for platform/provider credentials managed by
-- the server code, untouchable by agents).
--
-- The credentials column is an AES-256-GCM ciphertext blob; iv + auth_tag
-- live alongside. The master key is stored in secrets.yaml under
-- credential_master_key (auto-generated on first server start). Never
-- decays, never appears in vault_search, never gets pulled into the
-- Dreamer's knowledge extraction.

CREATE TABLE IF NOT EXISTS agent_credentials (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL UNIQUE,
  description TEXT,
  encrypted_credentials BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  created_by_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  last_accessed_by_agent_id TEXT,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_service ON agent_credentials(service_name);
