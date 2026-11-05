-- 214 (v3.5 field fix 3, re-review 5 P1): A BACKGROUND COMMAND'S CALL, ON ITS ROW.
--
-- A command handed to the background is written to the task ledger as "still running" and must take
-- its real exit status when it ends. That link was an in-memory map with a one-hour drop, and a
-- restart left the ledger saying "still running" forever. It now lives on the rows:
--   background_commands.call_id      the tool call that was handed back
--   background_commands.exit_status  set when the command ends (NULL while it runs)
--   background_commands.result_saved 1 once its result is saved for the agent
--   work_ledger.call_id              the call that last wrote a command row
-- The ended command settles its ledger row by call id; a restart settles every row still running.
-- A new migration rather than an edit of 213: 213 has already run on boxes in this wave, and an
-- applied migration is never re-run, so an edited 213 would leave those boxes without the columns.
-- The pid index had no reader (rows are deleted by id); it is replaced by the call-id lookups.

ALTER TABLE background_commands ADD COLUMN call_id TEXT;
ALTER TABLE background_commands ADD COLUMN exit_status TEXT;
ALTER TABLE background_commands ADD COLUMN result_saved INTEGER NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS idx_background_commands_pid;
CREATE INDEX IF NOT EXISTS idx_background_commands_call ON background_commands(call_id);
ALTER TABLE work_ledger ADD COLUMN call_id TEXT;
CREATE INDEX IF NOT EXISTS idx_work_ledger_call ON work_ledger(call_id);
