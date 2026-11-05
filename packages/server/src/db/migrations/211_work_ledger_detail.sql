-- 211 (v3.5 field fix 3): THE LEDGER LEARNS THE WORKER'S FILE AND COMMAND WORK.
--
-- The task ledger (`work_ledger`, migration 200) knew only mailbox items, so a task whose work was
-- files and commands had an empty ledger and the project manager could only judge it on the worker's
-- own description. The engine now records, on the same ledger and from the same seam, the files a
-- task's calls wrote (`file:<path>`) and the commands they ran (`cmd:<command>`). A command's exit
-- status is the one fact the key cannot carry, so it lands here: "exit 0", "exit 1", "killed by
-- SIGTERM" and so on, the newest run's. NULL for every other entry.
--
-- Additive only: one nullable column, no existing value changes, so a box of any age applies it in O(1).

ALTER TABLE work_ledger ADD COLUMN detail TEXT;
