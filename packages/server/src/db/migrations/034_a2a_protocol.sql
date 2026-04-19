-- A2A Protocol: Structured inter-agent messaging with thread tracking.
-- Eliminates acknowledgement loops at the protocol level.

-- Thread state tracking
CREATE TABLE IF NOT EXISTS a2a_threads (
  thread_id TEXT PRIMARY KEY,
  hop_count INTEGER DEFAULT 0,
  last_intent TEXT,
  last_sender TEXT,
  is_terminal INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Add A2A envelope fields to the messages table so context assembly
-- can identify inter-agent messages by thread and intent.
ALTER TABLE messages ADD COLUMN a2a_thread_id TEXT;
ALTER TABLE messages ADD COLUMN a2a_intent TEXT;
ALTER TABLE messages ADD COLUMN a2a_requires_response INTEGER;

-- Force a session reset on ALL agents so they pick up the new
-- send_to_agent tool schema (intent + payload replaces message).
-- Setting session_started_at to now means context assembly will only
-- include messages from after this point — the agent starts fresh
-- with the new protocol in its system prompt.
UPDATE agents SET session_started_at = datetime('now'), updated_at = datetime('now')
  WHERE status != 'terminated';
