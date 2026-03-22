-- ════════════════════════════════════════
-- Phase 2: Memory Engine
-- ════════════════════════════════════════

-- FTS5 Index on Messages (for memory_grep)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Trigger to keep FTS in sync with the immutable store
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Summaries (The DAG)
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  depth INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  earliest_at TEXT NOT NULL,
  latest_at TEXT NOT NULL,
  descendant_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_summaries_agent_depth
  ON summaries(agent_id, depth, created_at);

-- Summary-Message Links (Leaf -> Source Messages)
CREATE TABLE IF NOT EXISTS summary_messages (
  summary_id TEXT NOT NULL REFERENCES summaries(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY (summary_id, message_id)
);

-- Summary-Parent Links (Condensed -> Parent Summaries)
CREATE TABLE IF NOT EXISTS summary_parents (
  summary_id TEXT NOT NULL REFERENCES summaries(id),
  parent_id TEXT NOT NULL REFERENCES summaries(id),
  PRIMARY KEY (summary_id, parent_id)
);

-- Context Items (Ordered Context List Per Agent)
CREATE TABLE IF NOT EXISTS context_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  UNIQUE(agent_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_context_items_agent
  ON context_items(agent_id, ordinal);

-- Large Files (Intercepted File Store)
CREATE TABLE IF NOT EXISTS large_files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  original_path TEXT,
  mime_type TEXT,
  token_count INTEGER NOT NULL,
  exploration_summary TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- FTS5 Index on Summaries (for memory_grep)
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content,
  content='summaries',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Morning Briefing
CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  generated_at TEXT DEFAULT (datetime('now')),
  manual_edits TEXT
);
