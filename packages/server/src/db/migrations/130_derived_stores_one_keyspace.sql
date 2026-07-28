-- 130_derived_stores_one_keyspace.sql — PHASE-1 T7: the DERIVED stores come home.
--
-- Three stores are computed FROM `messages` and two of them still carried the shape of the
-- two-table world in their schema. This closes both. (The third and fourth, the full-text
-- index and the embeddings, need no DDL: migration 127 rebuilt `messages_fts` over the
-- unified table, and `embeddings` was id-keyed all along so it survived the cutover intact.
-- The FTS REPAIR path did need a fix, and it is code, not schema — db/migrations.ts.)
--
-- ── 1. ONE ARCHIVAL HIGH-WATER ──────────────────────────────────────────────────────────
--
-- `vault_conversations.latest_rowid` (migration 088) answers "how far into this agent's
-- history have I already archived", so a session reset cannot re-copy all-time history.
-- Migration 100 added `latest_ia_rowid` as its twin for the SECOND message table, which had
-- its own independent rowid sequence. Two columns, two keyspaces, one question.
--
-- PHASE-1 T5 already deleted the code half: `archiveAgentStoreConversation`,
-- `archiveStoreMessagesToVault` and `getStoreArchiveHighWaterMark` are gone, and the
-- surviving arm reads `messages` alone bounded by `seq > latest_rowid`. This is the schema
-- half. Measured on the live dev box immediately before this file was written:
--   sqlite3 … "SELECT COUNT(*) FROM vault_conversations"                       -> 532
--   sqlite3 … "SELECT COUNT(*) FROM vault_conversations WHERE latest_ia_rowid IS NOT NULL"
--                                                                              -> 133
-- Those 133 values are historical high-waters in a rowid space nothing reads any more; the
-- 491 rows they bounded are still in `inter_agent_messages`, which T10 drops and which T12's
-- Bridge merges on a lived-in box (re-pointing the per-agent high-water in the SAME
-- transaction, per Part V — the runaway-re-summarization hazard).
--
-- STRIP; requirement preserved: an archive never re-copies history it has already copied —
-- now carried by ONE high-water, in the SAME keyspace it is compared against. That last
-- clause is the defect T5 found and fixed at this exact boundary: the two-arm loader could
-- emit the OTHER table's rowid into `Message.rowid`, which the archive persists as
-- `latest_rowid`; from that moment every later archive silently skips real history, with no
-- error. One column cannot be handed a foreign number.
--
-- On a box that has never archived, `latest_rowid` is NULL for that agent and MAX() over
-- nothing is NULL — archive-everything-once, which is the correct behaviour after a local
-- reset and is asserted in memory/__tests__/derived-stores.test.ts.
ALTER TABLE vault_conversations DROP COLUMN latest_ia_rowid;

-- ── 2. summary_messages GETS ITS REAL FOREIGN KEY BACK ──────────────────────────────────
--
-- This is the migration-103 reversal, and 103 was RIGHT when it was written. Its header
-- records the incident: on the night of 2026-07-06 every compaction whose chunk contained an
-- inter-agent row failed with "FOREIGN KEY constraint failed", because `message_id` still
-- carried REFERENCES messages(id) from the single-table era while agent-to-agent rows lived
-- in `inter_agent_messages` with their own ids. The failed link INSERT rolled back the whole
-- leaf summary, the context never shrank, and reactive compaction re-fired on every turn.
-- 103 dropped the constraint and left `message_id` an OPAQUE id.
--
-- One table means the constraint is correct again, and an unconstrained id has a real cost:
-- nothing stops a link outliving its message, and a summary that claims to compress a
-- message nobody can produce is a lie the memory layer tells itself.
--
-- WHAT THIS DOES NOT DO IS RE-OPEN THE INCIDENT. The constraint alone would: the summarizer's
-- model call sits BETWEEN reading a chunk and writing the summary, so a reset_session or the
-- PM prune can still delete a row the chunk names inside that window. The link INSERT in
-- memory/dag.ts is SELECT-guarded in the same commit as this file, so an unresolvable id is a
-- link not written rather than a compaction that cannot complete. Both halves are asserted in
-- memory/__tests__/derived-stores.test.ts ("compaction still succeeds when a message vanished
-- underneath it").
--
-- ON DELETE CASCADE, and this is a CHANGE from the pre-103 shape rather than a restoration of
-- it. The old constraint had no cascade, and tracker/pm-agent.ts:742 carries the scar in as
-- many words: "a raw DELETE on a compacted PM message throws and the prune fails forever
-- (pm-agent log spam observed in production: 'Failed to prune PM messages' every 10 min for
-- hours)". Four live paths delete message rows (memory/message-store.ts: deleteAllForAgent,
-- deleteForAgentBefore, deleteNonSystemForAgent, deleteAgentBusRowsFor) and each would have
-- to remember to clear links first, forever. The cascade makes it structural: a link dies
-- with the message it describes, which is the only thing it could honestly mean.
--
-- THE 120 LINKS THAT DO NOT COPY, decided explicitly and measured, not sampled:
--   SELECT COUNT(*) FROM summary_messages sm LEFT JOIN messages m ON m.id=sm.message_id
--     WHERE m.id IS NULL                                                        -> 120
--   … the same, additionally LEFT JOINing inter_agent_messages                  -> 120 resolve there
--   … the same, additionally LEFT JOINing legacy_messages                       -> 0
--   … resolving in NO table at all                                              -> 0
-- Every one of the 120 names a row in `inter_agent_messages` — the 491 rows migration 127
-- deliberately did not copy on this box (readers first, the table itself at T10; the lived-in
-- equivalent MERGES them, and that is T12's Bridge, which is where these links are preserved
-- for a real user). They are dropped here rather than carried, on positive evidence and not
-- on an absence: since T5 every by-id message lookup in the platform reads `messages` alone,
-- so `getSummarySourceMessages` and `getCompactedMessageIds` already resolve exactly nothing
-- for these ids. Dropping them changes no answer any reader can give; keeping them would mean
-- keeping the FK off, which is the whole point of this step.
--   Dedup: research 22 measured 617 double-membered message ids on lived-in databases (the
--   pre-withLock duplicate-summary race). On THIS box the same query measures ZERO —
--   SELECT COUNT(*) FROM (SELECT message_id FROM summary_messages GROUP BY message_id
--     HAVING COUNT(DISTINCT summary_id) > 1)                                    -> 0
--   and exact duplicate rows are already impossible under the composite primary key
--   (measured 0 as well). SELECT DISTINCT below is belt-and-braces for a box where the PK
--   was somehow bypassed; the lived-in dedup rides with T12, which is the only place the
--   double-membered rows exist to be deduped.
--
-- SQLite cannot add a constraint in place: standard rebuild (new table, copy, drop, rename),
-- the same shape 103 used. The leading DROP IF EXISTS is 103's idempotence guard, kept.
DROP TABLE IF EXISTS summary_messages_new;

CREATE TABLE summary_messages_new (
  summary_id TEXT NOT NULL REFERENCES summaries(id),
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, message_id)
);

INSERT INTO summary_messages_new (summary_id, message_id)
  SELECT DISTINCT sm.summary_id, sm.message_id
    FROM summary_messages sm
    JOIN messages m ON m.id = sm.message_id;

DROP TABLE summary_messages;

ALTER TABLE summary_messages_new RENAME TO summary_messages;

-- The composite primary key indexes (summary_id, message_id), so a lookup BY message_id is a
-- full scan — and that is the lookup every cascading DELETE now performs, once per deleted
-- message row. Without this index a reset_session on a compacted agent turns into a scan per
-- message. The child key of a foreign key wants its own index; this is that index.
CREATE INDEX IF NOT EXISTS ix_summary_messages_message ON summary_messages(message_id);
