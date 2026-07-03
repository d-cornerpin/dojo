-- 080: D17, force re-embedding of summaries that were truncated at the old cap.
--
-- The C12 regression capped summary embeddings at 2000 characters. On this DB
-- that left 188 summary embeddings representing only the first ~20-45% of their
-- source (avg summary ~4.7k chars; depth-2 ~12k), so the back half of most
-- summaries was invisible to vector recall. The char cap has been raised to 7000
-- (embeddings.ts; the C12 halving-retry still rescues genuine token overflow).
--
-- Deleting the stale (truncated) summary-embedding rows lets the scheduled
-- embedding backfill (index.ts) re-embed those summaries whole at the new cap.
-- Embeddings are regenerable derived data, so this loses nothing permanent; it
-- only removes rows that under-represent their source. Short summaries that fit
-- under the old cap keep their embedding (not deleted, not re-embedded).

DELETE FROM embeddings
 WHERE source_type = 'summary'
   AND source_id IN (SELECT id FROM summaries WHERE length(content) > 2000);
