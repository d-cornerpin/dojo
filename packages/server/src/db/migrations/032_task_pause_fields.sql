-- Add fields for timed task pausing with auto-resume.
-- paused_until: datetime when the task should auto-resume (NULL = indefinite pause)
-- status_before_pause: the status the task had before being paused, so we can restore it

ALTER TABLE tasks ADD COLUMN paused_until TEXT;
ALTER TABLE tasks ADD COLUMN status_before_pause TEXT;
