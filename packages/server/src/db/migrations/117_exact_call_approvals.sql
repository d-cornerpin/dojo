-- 117: exact-call destructive approvals (lanes & lineage P7; owner ruling
-- 2026-07-20: "your approval covers precisely the command you saw, once").
--
-- The consumption key was the loop detector's LOSSY fingerprint (drops prose
-- fields, truncates long strings, masks digit runs): two destructive commands
-- differing only in a long tail collapsed to one signature, and an approval
-- could be consumed by a later same-shaped call within the TTL. The approval
-- now stores the FULL argument JSON and consumption requires exact equality;
-- rows also carry execution lineage (who asked, which turn, which root).
ALTER TABLE destructive_approvals ADD COLUMN args_json TEXT;
ALTER TABLE destructive_approvals ADD COLUMN root_kind TEXT;
ALTER TABLE destructive_approvals ADD COLUMN root_id TEXT;
ALTER TABLE destructive_approvals ADD COLUMN task_id TEXT;
ALTER TABLE destructive_approvals ADD COLUMN turn_number INTEGER;
