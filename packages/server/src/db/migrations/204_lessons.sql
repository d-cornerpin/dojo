-- 204 (v3.5, Harness² §9): LESSONS FROM ROUGH TASKS — the Dreamer's, with an expiry; never the vault.
--
-- Once per cycle the engine picks out the tasks that went badly (vault/friction-census.ts, no
-- model) and the Dreamer writes at most one lesson per task through `lesson_record`. A lesson is
-- a cue (the situation that should bring it to mind), the lesson itself, the ids of the task's
-- own events that show it, a confidence, and which component to change:
--   technique | door_text | soul | engine
-- It expires 90 days after it was last written; a recurring cue renews it (`renewed_count`)
-- instead of adding a second row. The Trainer's distillation reads `component = 'technique'`
-- lessons as candidates. Lessons are NOT vault entries and are never injected into any agent.
--
-- Additive only: a brand-new table, so a body of any age applies it in O(1). It starts empty.
-- CREATE TABLE IF NOT EXISTS is a no-op on a body that already carries a table of this name.

CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, cue TEXT NOT NULL, lesson TEXT NOT NULL,
  evidence_event_ids TEXT NOT NULL, confidence REAL NOT NULL, component TEXT NOT NULL,  -- technique | door_text | soul | engine
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewed_count INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_lessons_expires ON lessons (expires_at);
