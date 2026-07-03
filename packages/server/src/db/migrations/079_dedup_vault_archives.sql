-- 079: reclaim redundant nested full-history archives (D1).
--
-- Before the high-water archival bound (vault/archive.ts getArchiveHighWaterMark),
-- every session reset re-copied an agent's ENTIRE all-time history into
-- vault_conversations. The primary agent accumulated hundreds of nested
-- superset blobs (same earliest_at, growing latest_at, up to ~24 MB each), which
-- flooded the Dreamer queue (it re-chewed the same history and dedup-dropped it)
-- and grew the DB ~1 GB/day. The code fix stops NEW duplicates; this migration
-- clears the existing redundant backlog.
--
-- SAFE SCOPE: deletes only is_processed = 0 archives whose entire span is fully
-- covered by a larger-or-equal archive of the SAME agent (their content is
-- contained elsewhere). Unprocessed rows have never had vault entries extracted,
-- so no source provenance is orphaned (verified: 0 vault_entries reference a
-- conversation as source). Processed archives are left untouched here.
--
-- NOTE (operator): this frees pages for reuse but does NOT shrink the DB file.
-- Reclaiming the ~6 GB of already-processed historical blobs and physically
-- shrinking the file is a deliberate, heavy, irreversible operation (bulk delete
-- of processed archives + VACUUM) and must NOT run silently at boot. Run it by
-- hand under supervision. A boot migration that VACUUMs a multi-GB DB would lock
-- startup for minutes.
--
-- Uses a small metadata temp table so the O(n^2) span-coverage check never
-- rescans the multi-GB `messages` blob column (a correlated scan over the live
-- table takes minutes; the temp-table version takes ~2 s).

CREATE TEMP TABLE _vc_meta AS
  SELECT id, agent_id, earliest_at, latest_at, message_count, is_processed, rowid AS rid
    FROM vault_conversations;

CREATE INDEX _vc_meta_agent ON _vc_meta(agent_id);

DELETE FROM vault_conversations WHERE id IN (
  SELECT v.id FROM _vc_meta v
   WHERE v.is_processed = 0
     AND EXISTS (
       SELECT 1 FROM _vc_meta w
        WHERE w.agent_id = v.agent_id
          AND w.id <> v.id
          AND w.earliest_at <= v.earliest_at
          AND w.latest_at   >= v.latest_at
          AND w.message_count >= v.message_count
          -- keep exactly one row among identical-span/identical-count peers
          AND (w.message_count > v.message_count OR w.rid > v.rid)
     )
);

DROP TABLE _vc_meta;
