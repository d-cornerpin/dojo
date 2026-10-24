-- 200 (v3.5, DONE IS MEASURED): A TASK CAN CARRY A MEASURE, AND THE ENGINE KEEPS ITS LEDGER.
--
-- measure_json       the read the engine can replay and count: {"tool":"gmail_search","args":{"query":"…","account":"…"},"unit":"messages"}
-- measure_initial    what the measure returned when it was set
-- measure_remaining  what it returned when last re-run
-- measure_at         when it was last re-run (epoch ms, the unit `updated_at` uses)
--
-- work_ledger        one row per (task, item) the task's tool calls touched, written by the engine
--                    from the calls themselves (never by the model). `item_key` is the provider's
--                    id prefixed by kind ("gmail:msg:<id>", "gmail:thread:<id>"). PRIMARY KEY makes
--                    a re-touch an update of `last_at`, so COUNT(*) is "distinct items touched".
--
-- The reference into work(id) is NO ACTION, like the other four: every path that deletes a work
-- row clears it by hand through work/work-refs.ts `clearReferencesToWork`, the one list.
--
-- Additive only. A row written before this migration reads NULL = "no measure", and the ledger
-- starts empty, so a body of any age applies it in O(1).

ALTER TABLE work ADD COLUMN measure_json TEXT;
ALTER TABLE work ADD COLUMN measure_initial INTEGER;
ALTER TABLE work ADD COLUMN measure_remaining INTEGER;
ALTER TABLE work ADD COLUMN measure_at INTEGER;

CREATE TABLE IF NOT EXISTS work_ledger (
  work_id  TEXT NOT NULL REFERENCES work(id),
  item_key TEXT NOT NULL,
  tool     TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (work_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_work_ledger_last ON work_ledger(work_id, last_at);
