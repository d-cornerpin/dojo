-- 088: rowid high-water for archival (D1 follow-up).
--
-- getArchiveHighWaterMark used MAX(latest_at), a whole-second TEXT timestamp, and
-- callers filtered `created_at > highWater`. When two messages share a whole
-- second, the equal-second boundary row was skipped by the Dreamer (never copied
-- to vault_conversations) yet still lossily compacted, a silent data loss. rowid
-- is unique and monotonic, so a rowid high-water has no ties. Store the max
-- archived message rowid per archive; getArchiveHighWaterMark now returns
-- MAX(latest_rowid) and callers filter `rowid > highWater`.
--
-- Backfill existing rows conservatively: the largest message rowid at or before
-- the archived latest_at. That is >= any actually-archived rowid, so it never
-- triggers a mass re-archive of history already in the vault (the whole point of
-- the D1 high-water). Rows with no matching message stay NULL (archive-everything
-- once, deduped by migration 079). The UPDATE is idempotent (only fills NULLs).

ALTER TABLE vault_conversations ADD COLUMN latest_rowid INTEGER;

UPDATE vault_conversations
   SET latest_rowid = (
     SELECT MAX(m.rowid) FROM messages m
      WHERE m.agent_id = vault_conversations.agent_id
        AND m.created_at <= vault_conversations.latest_at
   )
 WHERE latest_rowid IS NULL;
