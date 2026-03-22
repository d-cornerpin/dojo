-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 5: System Control, Vector Search, Auth Hardening
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Vector Embeddings (5C) ──

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,           -- "message" | "summary" | "briefing"
  source_id TEXT NOT NULL,             -- ID of the message or summary
  agent_id TEXT,                       -- Scoping: which agent's memory
  content_preview TEXT,                -- First 200 chars of the embedded text
  embedding BLOB NOT NULL,             -- Raw float32 vector as binary
  dimensions INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_source
  ON embeddings(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_embeddings_agent
  ON embeddings(agent_id);

-- ── Session Management (5D) ──

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_activity_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
