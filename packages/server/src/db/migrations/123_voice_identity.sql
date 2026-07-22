-- 123: voice identity (lanes & lineage phase 8).
--
-- The spoken lane gets what every other lane already has: durable identity.
-- A voice SESSION becomes a row (the dashboard WS session was pure process
-- memory; a dropped connection left no record it ever happened). Phone calls
-- keep twilio_call_log as their call record; their voice_sessions row (kind
-- 'phone', external_id = callSid) gives the two spoken surfaces ONE session
-- identity space.
CREATE TABLE IF NOT EXISTS voice_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT,
  conversation_id TEXT,
  stt_model TEXT,
  tts_engine TEXT,
  voice_id TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  end_reason TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_agent ON voice_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_external ON voice_sessions(external_id) WHERE external_id IS NOT NULL;

-- Speaker stamps: WHO a spoken row belongs to, as a column, not transcript
-- prose. Vocabulary: 'owner' (dashboard voice inbound), 'caller' (phone
-- inbound), 'agent' (the spoken reply). NULL = not a spoken row.
ALTER TABLE messages ADD COLUMN speaker TEXT;
ALTER TABLE messages ADD COLUMN voice_session_id TEXT;

-- Spoken-stream lane typing on the turn record: consumers read the lane off
-- the turns row instead of re-deriving it from source flags and prose.
ALTER TABLE turns ADD COLUMN lane TEXT;
