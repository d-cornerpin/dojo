-- Phase B.0: structured task audit log.
--
-- Replaces the freeform tasks.notes column as the canonical record of every
-- touch on a task. Every status transition, every observation, every
-- engine sweep, every PM directive lands as one row here.
--
-- The PM agent (and the dashboard, and the agent context renderer) reads
-- this table instead of grepping prose. tasks.notes stays as a frozen
-- read-only legacy column (Q7 from the plan); new code never writes it.
--
-- One-time backfill: each existing task's current notes blob becomes a
-- single legacy_note row, so the audit trail does not lose pre-migration
-- history.

CREATE TABLE IF NOT EXISTS task_log (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_entity     TEXT NOT NULL,         -- 'agent:<id>' | 'pm' | 'engine' | 'user' | 'scheduler'
  entry_kind      TEXT NOT NULL,         -- 'transition' | 'observation' | 'reject' | 'override' |
                                         -- 'evidence' | 'directive' | 'poke' | 'auto_sweep' |
                                         -- 'smell_flag' | 'user_verdict_request' | 'user_verdict_applied' |
                                         -- 'legacy_note'
  from_status     TEXT,                  -- nullable, populated on transitions
  to_status       TEXT,                  -- nullable, populated on transitions
  reason          TEXT,                  -- short structured "why"
  action_taken    TEXT,                  -- short structured "what"
  note            TEXT,                  -- freeform prose (observations, legacy notes)
  evidence_json   TEXT,                  -- JSON when this entry attaches evidence
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_log_task_id ON task_log(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_log_kind ON task_log(entry_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_task_log_entity ON task_log(from_entity, created_at);

-- Backfill: every existing task with non-empty notes gets one legacy_note row.
-- Uses lower(hex(randomblob(N))) for ids that are non-UUID-looking but unique;
-- new writes from app code use uuidv4 so this is just for the migration trail.
INSERT INTO task_log (id, task_id, from_entity, entry_kind, note, created_at)
SELECT
  'legacy-' || lower(hex(randomblob(8))) || '-' || substr(id, 1, 8),
  id,
  'legacy',
  'legacy_note',
  notes,
  COALESCE(updated_at, created_at, datetime('now'))
FROM tasks
WHERE notes IS NOT NULL AND length(trim(notes)) > 0;
