-- 208 (v3.5): A VAULT MEMORY LOSES CONFIDENCE AT MOST ONCE PER 30 UNUSED DAYS.
--
-- The nightly clean-up lowered the confidence of any memory unused for 30+ days by a tenth EVERY
-- night, so a memory last used a month ago was deleted about ten nights later. The intent is a slow
-- fade: one step, then wait another 30 days. `last_decayed_at` records when the last step happened
-- so the clean-up can wait.
--
-- Existing rows are stamped "now": a box updating gives every stale memory one fresh 30-day window
-- instead of a step on the first night, so nothing is lost by the update. NULL (rows created later)
-- means "never faded" and is gated by the memory's own age and last use.
--
-- Additive only: one nullable column and one UPDATE of the new column; no existing value changes.

ALTER TABLE vault_entries ADD COLUMN last_decayed_at TEXT;
UPDATE vault_entries SET last_decayed_at = datetime('now');
