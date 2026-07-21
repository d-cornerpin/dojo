-- 111: normalize the legacy terminal status string 'completed' (May-era
-- vocabulary) to the live vocabulary 'complete'.
--
-- Why: every reader that defines "active" by excluding terminal statuses
-- excludes 'complete' but has never heard of 'completed', so months-dead rows
-- resurrected as "active" in the PM review (owner-reported 2026-07-21: ~24
-- long-gone tasks dragged into every review) while project-scoped dashboard
-- views hid them. No current writer emits 'completed'; these rows are fossils.
--
-- Grandfathered as validated (owner-approved 2026-07-21): these closes predate
-- the two-key contract; leaving complete_validated=0 would push the same dead
-- rows into the PM's unvalidated-complete sweep instead, trading one
-- resurrection for another. completed_at is backfilled from updated_at where
-- missing so terminal ordering stays sane.
UPDATE tasks SET
  status = 'complete',
  complete_validated = 1,
  completed_at = COALESCE(completed_at, updated_at),
  updated_at = datetime('now')
WHERE status = 'completed';
