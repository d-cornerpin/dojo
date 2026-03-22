-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 6: Scheduled Tasks + Agent Groups
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Task Schedule (extends existing tasks table) ──

ALTER TABLE tasks ADD COLUMN scheduled_start TEXT;
ALTER TABLE tasks ADD COLUMN repeat_interval INTEGER;
ALTER TABLE tasks ADD COLUMN repeat_unit TEXT;
ALTER TABLE tasks ADD COLUMN repeat_end_type TEXT;
ALTER TABLE tasks ADD COLUMN repeat_end_value TEXT;
ALTER TABLE tasks ADD COLUMN next_run_at TEXT;
ALTER TABLE tasks ADD COLUMN run_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN is_paused INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_run_at TEXT;
ALTER TABLE tasks ADD COLUMN schedule_status TEXT DEFAULT 'unscheduled';

-- ── Task Run History ──

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_number INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_to TEXT REFERENCES agents(id),
  result_summary TEXT,
  tokens_used INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, run_number);
CREATE INDEX IF NOT EXISTS idx_task_runs_scheduled ON task_runs(scheduled_for);

-- ── Agent Groups ──

CREATE TABLE IF NOT EXISTS agent_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  color TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Add group_id to agents table
ALTER TABLE agents ADD COLUMN group_id TEXT REFERENCES agent_groups(id);

-- Add group assignment option to tasks
ALTER TABLE tasks ADD COLUMN assigned_to_group TEXT REFERENCES agent_groups(id);
