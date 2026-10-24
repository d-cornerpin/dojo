-- 203 (v3.5, PLAN BEFORE PROJECT): A PROJECT CARRIES THE PLAN ITS AGENT WROTE.
--
-- plan_json   {"approach": "...", "steps": [{"title","how","done","measure"?}]} — written once, by the
--             door that opens a project for an agent (a project opened from the dashboard, or before
--             this migration, reads NULL = "no plan", which is a normal value, not a gap).
--
-- Additive only: one nullable column, O(1) on a body of any age.

ALTER TABLE work ADD COLUMN plan_json TEXT;
