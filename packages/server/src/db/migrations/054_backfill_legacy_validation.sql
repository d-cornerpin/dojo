-- v2.8.1: backfill validation flags for tasks that already existed
-- before the v2.8 overseer system was installed.
--
-- Without this, every previously-completed task in an upgraded user's
-- tracker (potentially dozens or hundreds) becomes "unvalidated" the
-- moment v2.8 starts up. The 5-min escalation sweep then spams the user
-- with VALIDATION CHECK chat messages on every one of those legacy
-- transitions, even though the user had already accepted them as
-- complete by virtue of the agent having marked them so under v2.7.
-- Subjecting those tasks to retroactive PM validation creates noise
-- without value.
--
-- This migration treats any existing terminal/paused state as already
-- validated. Going forward (post-v2.8.1), only NEW transitions need
-- PM validation.

UPDATE tasks
SET complete_validated = 1
WHERE status = 'complete' AND complete_validated = 0;

UPDATE tasks
SET pause_validated = 1
WHERE status = 'paused' AND pause_validated = 0;

UPDATE tasks
SET blocked_validated = 1
WHERE status = 'blocked' AND blocked_validated = 0;

-- Clear any escalations that already fired during the brief window
-- between v2.8 install and this migration running, so the user doesn't
-- get a follow-up "I asked you about this earlier" notification on a
-- task that's now considered validated.
UPDATE tasks
SET validation_escalated_at = NULL,
    validation_thread_id = NULL
WHERE validation_escalated_at IS NOT NULL
  AND (complete_validated = 1 OR pause_validated = 1 OR blocked_validated = 1);
