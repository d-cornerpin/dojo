-- Healer agent tables for self-healing diagnostics, proposals, and auto-fix logging.

CREATE TABLE IF NOT EXISTS healer_diagnostics (
  id TEXT PRIMARY KEY,
  report TEXT NOT NULL,
  critical_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  info_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS healer_proposals (
  id TEXT PRIMARY KEY,
  diagnostic_id TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposed_fix TEXT NOT NULL,
  fix_action TEXT,
  confidence INTEGER,
  status TEXT DEFAULT 'pending',
  user_note TEXT,
  result_summary TEXT,
  agent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS healer_actions (
  id TEXT PRIMARY KEY,
  diagnostic_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  agent_id TEXT,
  action_taken TEXT NOT NULL,
  result TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
