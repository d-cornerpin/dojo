-- 112: the lineage spine, phase 1 (lanes & lineage plan).
--
-- Every piece of work gets one origin. Root vocabulary (root_kind):
--   'ask'        root_id = messages.id of the inbound human message
--   'occurrence' root_id = task_runs.id (an explicitly scheduled fire)
--   'a2a'        root_id = a2a_thread_id (a peer assignment)
--   'engine'     root_id = the engine-event row id (engine maintenance)
--   'task'       root_id = tasks.id (fallback when the task predates the spine)
--
-- Work records carry the origin quad; engine-event rows carry the work they
-- are about as COLUMNS (until now the task/run reference lived only as prose
-- inside content, so no eligibility gate could ever see a spent premise).
-- All columns nullable; legacy rows stay NULL and every reader treats NULL
-- as "pre-spine, fall back to current behavior". Nothing is backfilled.

ALTER TABLE tasks ADD COLUMN source_message_id TEXT;
ALTER TABLE tasks ADD COLUMN origin_turn INTEGER;
ALTER TABLE tasks ADD COLUMN origin_conv_key TEXT;
ALTER TABLE tasks ADD COLUMN origin_kind TEXT;

ALTER TABLE projects ADD COLUMN source_message_id TEXT;
ALTER TABLE projects ADD COLUMN origin_turn INTEGER;
ALTER TABLE projects ADD COLUMN origin_conv_key TEXT;
ALTER TABLE projects ADD COLUMN origin_kind TEXT;

ALTER TABLE inter_agent_messages ADD COLUMN task_id TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN run_id TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN root_kind TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN root_id TEXT;

ALTER TABLE messages ADD COLUMN task_id TEXT;
ALTER TABLE messages ADD COLUMN run_id TEXT;
ALTER TABLE messages ADD COLUMN root_kind TEXT;
ALTER TABLE messages ADD COLUMN root_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_source_message ON tasks(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iam_task ON inter_agent_messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iam_run ON inter_agent_messages(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id) WHERE run_id IS NOT NULL;
