-- Phase B.1: structured validation fields on tasks.
--
-- Adds the goal/result/evidence triple plus the validation flags that
-- back the soft-gate-with-PM-overseer flow (see TRACKER-OVERSEER-PLAN.md
-- sections 5-7).
--
-- All columns are nullable or have safe defaults so existing rows keep
-- working under old code paths during a rolling deploy. Rollback is just
-- ignoring the new columns; old code does not reference them.

-- The definition of done. Required on new tasks per Q6.
ALTER TABLE tasks ADD COLUMN goal TEXT;

-- The agent's claim of what was accomplished, required on every
-- tracker_update_status(complete) call. For apprentices, completeAgent
-- plumbs completion_summary into this on terminal close.
ALTER TABLE tasks ADD COLUMN result TEXT;

-- JSON array of text-only evidence records {kind, claim, pointer?}.
-- Engine enforces non-empty array + each-entry-has-claim. PM judges
-- substance.
ALTER TABLE tasks ADD COLUMN evidence_json TEXT;

-- Mirrors pause_validated. PM flips to 1 on bless. Dependency cascade
-- and parent-agent notification fire only when validated=1.
ALTER TABLE tasks ADD COLUMN complete_validated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN blocked_validated INTEGER NOT NULL DEFAULT 0;

-- Counts PM rejections. Triggers user-verdict escalation when
-- revert_count >= USER_VERDICT_THRESHOLDS[task.priority]
-- ({high:2, normal:3, low:5}).
ALTER TABLE tasks ADD COLUMN revert_count INTEGER NOT NULL DEFAULT 0;

-- Most recent smell-pattern reason. PM reads as context, never used as a
-- hard block.
ALTER TABLE tasks ADD COLUMN last_smell_flag TEXT;

-- Stalemate escalation flag. When set, PM stops attempting validation
-- and the poke chain leaves the task alone until the user weighs in.
ALTER TABLE tasks ADD COLUMN awaiting_user_verdict INTEGER NOT NULL DEFAULT 0;

-- Timestamp of the user verdict request. Used for the 12h auto-expire
-- sweep (scheduler/runner.js).
ALTER TABLE tasks ADD COLUMN user_verdict_requested_at TEXT;

-- One-time backfill: goal copies from original_description (preferred)
-- with description as fallback. Existing rows that have neither will
-- keep goal NULL; the engine hard-rejects NEW task creations without
-- a goal but does not break old rows that pre-date the rule.
UPDATE tasks SET goal =
  COALESCE(
    NULLIF(trim(original_description), ''),
    NULLIF(trim(description), '')
  )
WHERE goal IS NULL;
