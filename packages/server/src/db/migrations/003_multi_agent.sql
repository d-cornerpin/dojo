-- ════════════════════════════════════════
-- Phase 3: Multi-Agent + Permissions + Tracker
-- ════════════════════════════════════════

-- Expand Agents Table
ALTER TABLE agents ADD COLUMN parent_agent TEXT REFERENCES agents(id);
ALTER TABLE agents ADD COLUMN spawn_depth INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN agent_type TEXT DEFAULT 'standard';
ALTER TABLE agents ADD COLUMN max_runtime INTEGER;
ALTER TABLE agents ADD COLUMN timeout_at TEXT;
ALTER TABLE agents ADD COLUMN permissions TEXT DEFAULT '{}';
ALTER TABLE agents ADD COLUMN tools_policy TEXT DEFAULT '{}';
ALTER TABLE agents ADD COLUMN task_id TEXT;

-- Inter-Agent Messages
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL REFERENCES agents(id),
  to_agent TEXT NOT NULL REFERENCES agents(id),
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  read_by_recipient INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to
  ON agent_messages(to_agent, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_messages_from
  ON agent_messages(from_agent, created_at);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_by TEXT NOT NULL,
  phase_count INTEGER DEFAULT 1,
  current_phase INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'on_deck',
  assigned_to TEXT REFERENCES agents(id),
  created_by TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  step_number INTEGER,
  total_steps INTEGER,
  phase INTEGER DEFAULT 1,
  depends_on TEXT DEFAULT '[]',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project
  ON tasks(project_id, step_number);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned
  ON tasks(assigned_to, status);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, priority);

-- Poke Log (PM Agent State Persistence)
CREATE TABLE IF NOT EXISTS poke_log (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  poke_number INTEGER NOT NULL,
  poke_type TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  response_received INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poke_log_task
  ON poke_log(task_id, poke_number);
