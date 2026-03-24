-- Phase 9: Google Workspace Integration

CREATE TABLE IF NOT EXISTS google_activity (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  action TEXT NOT NULL,
  action_type TEXT NOT NULL,
  details TEXT,
  gws_command TEXT,
  success INTEGER DEFAULT 1,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_google_activity_agent ON google_activity(agent_id);
CREATE INDEX IF NOT EXISTS idx_google_activity_action ON google_activity(action);
CREATE INDEX IF NOT EXISTS idx_google_activity_type ON google_activity(action_type);
CREATE INDEX IF NOT EXISTS idx_google_activity_created ON google_activity(created_at);
