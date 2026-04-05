-- Add 'agent-sdk' as a valid auth_type for the Agent SDK provider.
-- SQLite requires table recreation to modify CHECK constraints.

CREATE TABLE IF NOT EXISTS providers_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('anthropic', 'openai', 'openai-compatible', 'ollama')),
  base_url TEXT,
  auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'oauth', 'none', 'agent-sdk')),
  is_validated INTEGER NOT NULL DEFAULT 0,
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO providers_new SELECT * FROM providers;

DROP TABLE IF EXISTS providers;

ALTER TABLE providers_new RENAME TO providers;
