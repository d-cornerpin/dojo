-- 110: one-shot release of recurring schedules damaged by the demolished
-- pre-v2.9.13 engine auto-pause. This replaces the boot-time runtime scan
-- (recoverEnginePausedRecurringTasks, retired this release): the writer of the
-- pause signature was demolished in the two-key wave, so victim rows are a
-- fixed historical set and a migration releases them exactly once.
--
-- A released row whose next_run_at is stale-past fires one catch-up occurrence
-- through the normal due path (advance-at-fire recomputes from anchor_time;
-- the missed-runs machinery guards the pathological backlog case).
UPDATE tasks SET
  status = 'on_deck',
  is_paused = 0,
  schedule_status = 'waiting',
  next_run_at = COALESCE(next_run_at, datetime('now', '+5 minutes')),
  updated_at = datetime('now')
WHERE is_paused = 1
  AND status = 'paused'
  AND pause_validated = 0
  AND repeat_interval IS NOT NULL
  AND repeat_unit IS NOT NULL
  AND (notes LIKE '%Auto-paused by engine%'
    OR notes LIKE '%idle-with-in_progress%'
    OR notes LIKE '%pre-turn close-out gate%');
