-- ══════════════════════════════════════════
-- Phase 7: Techniques
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS techniques (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  author_agent_id TEXT,
  author_agent_name TEXT,
  tags TEXT DEFAULT '[]',
  directory_path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  build_project_id TEXT REFERENCES projects(id),
  build_squad_id TEXT REFERENCES agent_groups(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_techniques_state ON techniques(state);
CREATE INDEX IF NOT EXISTS idx_techniques_tags ON techniques(tags);

CREATE TABLE IF NOT EXISTS technique_versions (
  id TEXT PRIMARY KEY,
  technique_id TEXT NOT NULL REFERENCES techniques(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  technique_md TEXT NOT NULL,
  changed_by TEXT,
  change_summary TEXT,
  files_snapshot TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_technique_versions ON technique_versions(technique_id, version_number);

CREATE TABLE IF NOT EXISTS technique_usage (
  id TEXT PRIMARY KEY,
  technique_id TEXT NOT NULL REFERENCES techniques(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  used_at TEXT DEFAULT (datetime('now')),
  success INTEGER,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_technique_usage ON technique_usage(technique_id, used_at);
