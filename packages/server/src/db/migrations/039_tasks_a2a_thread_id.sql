-- ════════════════════════════════════════
-- Tasks: link auto-created ASSIGN tasks to their A2A thread
-- ════════════════════════════════════════
--
-- Engine-driven task creation: when an agent calls
-- send_to_agent({ intent: 'ASSIGN' }) the engine auto-creates a tracker
-- task assigned to the receiver. We use this column to check whether a
-- task already exists for a given A2A thread, so multiple ASSIGN
-- messages on the same thread don't spawn duplicate tasks (later
-- messages are treated as clarifications to the original task).

ALTER TABLE tasks ADD COLUMN a2a_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_a2a_thread ON tasks(a2a_thread_id);
