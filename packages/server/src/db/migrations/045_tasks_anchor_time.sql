-- v2.5.45 — Anchor time for recurring tasks.
--
-- Bug: prior to this migration, the scheduler computed the next run of
-- a recurring task as `last_run_at + interval`, where last_run_at was
-- the COMPLETION timestamp. A weekly task scheduled for Monday 06:00
-- that took 5 minutes to complete drifted to 06:05 the following week,
-- then 06:10, then 06:15...
--
-- Fix: store an explicit anchor_time. Each next-run calculation lands
-- on the next occurrence of the anchor, never on completion+interval.
-- Anchor is a full ISO timestamp; only its time-of-day matters for the
-- recurring drift fix (the unit advancer handles day-of-week / day-of-
-- month spacing). Storing the full timestamp keeps history (what was
-- the originally-scheduled start) and makes future edits trivial — the
-- user updates anchor_time, the next run lands on the new time.
--
-- Backfill: for every existing recurring task, set anchor_time to its
-- ORIGINAL scheduled_start. That preserves the user's intended wall-
-- clock alignment going forward.

ALTER TABLE tasks ADD COLUMN anchor_time TEXT;

UPDATE tasks
SET anchor_time = scheduled_start
WHERE repeat_interval IS NOT NULL
  AND scheduled_start IS NOT NULL
  AND anchor_time IS NULL;
