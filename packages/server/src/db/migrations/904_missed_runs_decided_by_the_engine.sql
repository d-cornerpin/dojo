-- A schedule an older build paused to ask its agent about missed runs goes back to waiting: the scheduler's next
-- pass runs its missed run if it is younger than one interval, or skips them all, like any other late schedule.
UPDATE work SET is_paused = 0, schedule_status = 'waiting'
 WHERE missed_runs_paused_at IS NOT NULL AND is_paused = 1 AND schedule_status = 'paused' AND provenance = 'live';

ALTER TABLE work DROP COLUMN missed_runs_paused_at;
