-- 114: first-class conversations (lanes & lineage plan, phase 5; owner ruling
-- 2026-07-20: "go all the way", a real table, not just a column).
--
-- A conversation stops being a lowercased string recomputed per read and
-- becomes a ROW with identity: channel + provider + counterparty + thread
-- root. This fixes the email collapse (two threads from one sender, or the
-- same sender across gmail and outlook, are DIFFERENT conversations) and
-- gives summaries/archives an identity to carry. conv_key keeps its
-- claim/park duty untouched; identity lives here.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider TEXT,
  counterparty_id TEXT,
  counterparty_name TEXT,
  thread_root TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT,
  UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)
);

-- Identity stamped AT INGEST, atomic with the row insert (never a follow-up
-- best-effort UPDATE that can lose a race).
ALTER TABLE messages ADD COLUMN conversation_id TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iam_conversation ON inter_agent_messages(conversation_id) WHERE conversation_id IS NOT NULL;

-- The channel's own external message identity, stored instead of discarded:
-- the iMessage guid (was a bolted-on 200-entry ring in a config blob) and the
-- SMS MessageSid (was serialized into prose and re-found by table scan).
-- The unique partial index IS the dedup now.
ALTER TABLE messages ADD COLUMN external_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id ON messages(agent_id, external_message_id) WHERE external_message_id IS NOT NULL;
