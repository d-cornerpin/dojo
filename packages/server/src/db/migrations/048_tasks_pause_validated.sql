-- v2.7.18: Pause validation flag.
-- When an agent transitions a task to status='paused', the engine sets
-- pause_validated=0. The PM agent reviews each unvalidated pause on its
-- next tick: if the pause reason names a real wait condition (e.g. user
-- was actually asked to do something), PM flips pause_validated=1 and
-- the task is permanently ignored. If PM judges the pause as gaming
-- (vague, complains about PM, no matching user request), PM reverts the
-- task to in_progress and sends the agent a directive.
--
-- Stops the moral-hazard pattern where agents pause tasks just to silence
-- the PM. Empty/short pause-reasons are already refused at the tool layer;
-- this column lets PM enforce the spirit of the rule, not just the letter.

ALTER TABLE tasks ADD COLUMN pause_validated INTEGER NOT NULL DEFAULT 0;
