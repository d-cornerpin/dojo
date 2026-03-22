-- ========================================
-- Phase 8: Persistent Memory Vault
-- Raw conversation archives + extracted knowledge entries
-- ========================================

-- Raw Conversation Archive
-- Stores complete conversations BEFORE compaction destroys them
CREATE TABLE IF NOT EXISTS vault_conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  messages TEXT NOT NULL,             -- JSON array of full message objects
  message_count INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  earliest_at TEXT NOT NULL,
  latest_at TEXT NOT NULL,
  is_processed INTEGER DEFAULT 0,
  processed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vault_conv_agent ON vault_conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_vault_conv_processed ON vault_conversations(is_processed);

-- Extracted Knowledge Entries
-- Structured knowledge from dreaming cycle or agent vault_remember
CREATE TABLE IF NOT EXISTS vault_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  type TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  context TEXT,
  confidence REAL DEFAULT 1.0,
  is_permanent INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  is_pinned INTEGER DEFAULT 0,
  is_obsolete INTEGER DEFAULT 0,
  superseded_by TEXT,
  retrieval_count INTEGER DEFAULT 0,
  last_retrieved_at TEXT,
  source_conversation_id TEXT,
  source TEXT DEFAULT 'extraction',
  embedding BLOB,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vault_agent ON vault_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_vault_type ON vault_entries(type);
CREATE INDEX IF NOT EXISTS idx_vault_pinned ON vault_entries(is_pinned);
CREATE INDEX IF NOT EXISTS idx_vault_obsolete ON vault_entries(is_obsolete);
CREATE INDEX IF NOT EXISTS idx_vault_confidence ON vault_entries(confidence);
CREATE INDEX IF NOT EXISTS idx_vault_source ON vault_entries(source);
CREATE INDEX IF NOT EXISTS idx_vault_permanent ON vault_entries(is_permanent);

-- Dream reports for history
CREATE TABLE IF NOT EXISTS dream_reports (
  id TEXT PRIMARY KEY,
  archives_processed INTEGER DEFAULT 0,
  memories_extracted INTEGER DEFAULT 0,
  techniques_found INTEGER DEFAULT 0,
  duplicates_merged INTEGER DEFAULT 0,
  contradictions_resolved INTEGER DEFAULT 0,
  entries_pruned INTEGER DEFAULT 0,
  entries_consolidated INTEGER DEFAULT 0,
  total_entries INTEGER DEFAULT 0,
  pinned_count INTEGER DEFAULT 0,
  permanent_count INTEGER DEFAULT 0,
  report_text TEXT,
  dream_mode TEXT DEFAULT 'full',
  model_id TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
