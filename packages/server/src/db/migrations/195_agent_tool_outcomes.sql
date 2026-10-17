-- 195 (t190, C1): A PER-TOOL OUTCOME RECORD, SO "THE TOOL IS BROKEN" IS A FACT AND NOT AN ECHO.
--
-- `agent_tool_failures` (067) is a per-CALL circling detector: one row per canonical call
-- signature, cleared only when that identical call succeeds. The live-status line read it as
-- per-tool health, and for that job its clear rule is wrong: a failure on one email stayed
-- "unresolved" forever while the same tool succeeded on every other email.
--
-- This table is the per-(agent, tool) truth, written on every tool result:
--   last_ok_at            when the tool last succeeded for this agent (NULL: never recorded)
--   last_fail_at          when it last failed (NULL: never recorded)
--   last_error            the error text of that last failure
--   consecutive_failures  failures since the last success; a success sets it to 0. Greater
--                         than 0 is exactly "the last thing that happened was a failure".
--   total_failures        every failure ever recorded, never reset
-- Instants are millisecond-resolution UTC text, so a failure and a success in the same second
-- still order.
--
-- Additive only: a brand-new table, nothing read, changed or deleted, so a body of any age
-- applies it in O(1). It starts empty on purpose: backfilling from `agent_tool_failures`
-- would resurrect exactly the stale "unresolved" rows this table exists to stop trusting.
-- `agent_tool_failures` is untouched and keeps its one real job, the circling note.
-- CREATE TABLE IF NOT EXISTS is a no-op on a body that already carries a table of this name.

CREATE TABLE IF NOT EXISTS agent_tool_outcomes (
  agent_id             TEXT NOT NULL,
  tool_name            TEXT NOT NULL,
  last_ok_at           TEXT,
  last_fail_at         TEXT,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_failures       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, tool_name)
);
