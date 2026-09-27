-- 178 (V3.2.2 RELEASE BLOCKER): work_events AND adjudications GET THEIR FIRST INDEXES.
--
-- work_events was born unindexed in the base schema and recreated by 159 still unindexed.
-- Every correlated subquery that asks "does this work row have an event of this kind" —
-- the validation expressions in `work/ask-settlement.ts` (:431 NOT EXISTS probe, :532 COUNT,
-- :868 MAX(created_at)), the audit trail reads in `work/audit-trail.ts`, and the PM poke
-- tick's per-task counts in `tracker/pm-agent.ts` — therefore full-scans the table PER WORK
-- ROW, PER CHECK, every 60-second tick and every dashboard task fetch.
--
-- WHY NOBODY FELT IT UNTIL NOW: the table is tiny on every dev box, fresh box, and test
-- fixture, so every plan was "correct on each box we looked at." On a months-old user box
-- the measured shape was 123,071 event rows × 762 work rows × several probes per tick —
-- hundreds of millions of row-visits a minute, the table larger than the 32MB page cache,
-- the engine pinned at 100% CPU for 40-50s of every 60. The platform read as frozen and
-- the stop button as dead (an abort cannot preempt a synchronous scan). A hand-created
-- copy of exactly this index cured that box live on 2026-09-27, which is this migration's
-- proof of correctness as well as its origin.
--
-- THE NAME IS LOAD-BEARING: `idx_work_events_work_id`, guarded by IF NOT EXISTS — the
-- cured box already carries the identical index under this exact name, so the migration
-- must compose with the hand fix, never fight it.
--
-- THE COLUMN ORDER IS THE QUERY LIST: `work_id` alone serves the NOT EXISTS probes;
-- `+ kind` serves the kind-filtered counts and existence checks; `+ created_at` lets
-- `MAX(created_at) WHERE work_id = ? AND kind = ?` read one index entry with no sort.
--
-- adjudications is the same class caught by the same audit: born unindexed, seven
-- non-test query sites filter it by `work_id` (verdict lookups per work row, the orphan
-- sweeps' `work_id IN (…)` deletes). It is small today and grows exactly like work does,
-- so it gets its index in the same change rather than in the next incident.
--
-- Indexes only. No data is read, changed, or deleted; a body of any age applies this in
-- O(table size) once and never again (update-integrity standard: an update never fails —
-- CREATE INDEX IF NOT EXISTS cannot fail on a body where the DDL is valid, and re-running
-- is a no-op by the guard, not by the _migrations marker).

CREATE INDEX IF NOT EXISTS idx_work_events_work_id ON work_events(work_id, kind, created_at);

CREATE INDEX IF NOT EXISTS idx_adjudications_work_id ON adjudications(work_id);
