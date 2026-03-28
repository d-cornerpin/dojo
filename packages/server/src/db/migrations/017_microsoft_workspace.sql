-- Microsoft 365 Integration

CREATE TABLE IF NOT EXISTS microsoft_activity (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  action TEXT NOT NULL,
  action_type TEXT NOT NULL,
  details TEXT,
  api_endpoint TEXT,
  success INTEGER DEFAULT 1,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_microsoft_activity_agent ON microsoft_activity(agent_id);
CREATE INDEX IF NOT EXISTS idx_microsoft_activity_action ON microsoft_activity(action);
CREATE INDEX IF NOT EXISTS idx_microsoft_activity_type ON microsoft_activity(action_type);
CREATE INDEX IF NOT EXISTS idx_microsoft_activity_created ON microsoft_activity(created_at);
