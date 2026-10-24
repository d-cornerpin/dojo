-- 205 (v3.5, Harness² §K36): THE STANDING INSTRUCTION, MEASURED PIECE BY PIECE.
--
-- Per-section sizes existed only in the context receipt, which is off by default and writes
-- JSON files. This table keeps them always: one row per agent per rendered section, rewritten
-- (UPSERT) at every assembly, so "what is each agent's standing instruction made of, and what
-- does each piece cost" is a query and not a debugging session.
--
--   entry_id         the registry entry that rendered the section (`sys.*`), or the lane the
--                    allocator admitted (`lane.*`); two parts from one entry are one row
--   tokens, chars    the section's size by the one estimator (`memory/budget.ts`) and its length
--   measured_at      epoch ms of the last assembly that rendered it
--   baseline_tokens  the section's size as of `baseline_at`, the reference for "has it grown";
--   baseline_at      the reference moves to the last measured value once it is a week old
--
-- A section the assembler stops rendering has its row deleted. A report, not a limit: nothing
-- reads this to refuse anything.
--
-- Additive only: a brand-new table, so a body of any age applies it in O(1). It starts empty
-- and fills at the next assembly. CREATE TABLE IF NOT EXISTS is a no-op on a body that already
-- carries a table of this name.

CREATE TABLE IF NOT EXISTS prompt_sections (
  agent_id        TEXT NOT NULL,
  entry_id        TEXT NOT NULL,
  tokens          INTEGER NOT NULL,
  chars           INTEGER NOT NULL,
  measured_at     INTEGER NOT NULL,
  baseline_tokens INTEGER,
  baseline_at     INTEGER,
  PRIMARY KEY (agent_id, entry_id)
);
