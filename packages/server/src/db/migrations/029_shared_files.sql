-- Track files created by agents that can be served via download URL.
CREATE TABLE IF NOT EXISTS shared_files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT DEFAULT 'application/octet-stream',
  size INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
