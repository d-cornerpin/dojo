-- 090 (FA-P1): make destructive-approval wakes first-class instead of
-- fire-and-forget.
--
-- The approval flow files a pending row, wakes the primary over A2A, and holds
-- the requesting worker so it survives to consume the approval. Pre-fix the wake
-- was try/caught-and-logged only, so a DROPPED wake (target not found, dedup, hop
-- limit) or a THROWN one left the row 'pending' with the worker still told it
-- would be woken, and no second reader existed to notice. These additive columns
-- let the engine tell an undeliverable request from a delivered one and bound the
-- sweeper's re-wake to exactly once.
--
--   wake_delivered  1 once a wake to the primary actually landed; 0 means the
--                   primary was NOT reached (worker is told to escalate in-band).
--   rewake_count    number of extra wakes the sweeper has fired; bounds "once more".
--
-- 'status' gains two informal values used by the sweeper (the column is plain
-- TEXT, no CHECK constraint): 'expired' (pending past the TTL, owner notified).
ALTER TABLE destructive_approvals ADD COLUMN wake_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE destructive_approvals ADD COLUMN rewake_count INTEGER NOT NULL DEFAULT 0;
