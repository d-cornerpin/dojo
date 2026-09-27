-- 175 (BACKLOG-CAMPAIGN): EMBEDDINGS THAT OUTLIVED THE THING THEY DESCRIBE.
--
-- `embeddings` is POLYMORPHIC — `(source_type, source_id)` names a row in one of four different
-- tables — so no foreign key can express it and SQLite cannot cascade it. `081` said this in its
-- own words and closed what it knew about with AFTER DELETE triggers plus a one-time sweep.
-- This migration finishes the job: the lane `081` never covered, and the backlog that came back.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ WHERE THESE ORPHANS CAME FROM — MEASURED, AND THE OBVIOUS ANSWER IS WRONG TWICE.
--
-- Counted on the owner's own body, read-only, at 45,216 embedding rows:
--
--   message     44,883 rows    630 ORPHANED  (1.4%)
--   summary        314 rows      0 ORPHANED
--   technique       19 rows     15 ORPHANED  (78.9%)
--   briefing         0 rows      — (declared by the type, no producer yet)
--
-- WRONG ANSWER 1: "nothing cleans up on delete." Something does. `messages_embed_ad` and
-- `summaries_embed_ad` have existed since `081` (2026-07-02), they are re-created by every one of
-- the four `messages` rebuilds (`127`/`131`/`132`/`133`), and they work — which is exactly why
-- `summary` is at zero.
--
-- WRONG ANSWER 2: "the rebuilds lost them." `DROP TABLE` genuinely does not fire an AFTER DELETE
-- trigger, and `131`/`132` both say so in their own headers — but the dates refute it as the
-- cause. The rebuilds all ran on 2026-07-28. The orphans are dated 2026-07-27 through
-- 2026-09-26 and are still arriving: 221 in July, 350 in August, 59 in September, the newest on
-- the day of this fix. A one-time event does not trickle for two months.
--
-- THE ACTUAL MECHANISM is a write-after-delete race in `memory/embeddings.ts`, and it is fixed in
-- the same change as this migration. `queueEmbedding` is fire-and-forget; `storeEmbedding` then
-- `await`s a model call that takes seconds and INSERTs afterwards. Delete the source inside that
-- window — a project-manager history trim, an Imaginer wipe, the behavioural harness teardown —
-- and the trigger fires while there is still nothing to delete, then the INSERT lands a row no
-- trigger can ever reach. The distribution is the signature: the harness bot 443, the project
-- manager 92, the primary 84. The INSERT is now `INSERT … SELECT … WHERE EXISTS`, so liveness and
-- write are one statement. THIS MIGRATION ONLY CLEANS UP; the engine fix stops the minting.
--
-- AND WHY THE `technique` LANE IS SO MUCH WORSE, proportionally: it has no trigger at all.
-- `techniques/store.ts` deletes the embedding in application code inside its own transaction,
-- which is correct and which only ever protects that ONE path. 78.9% orphaned is what
-- app-code-only cleanup measures out to in practice. It gets the trigger below.
--
-- ⚠ NOT AN FK. Repeating `081`'s reason because it is the question a reader will ask: a foreign
-- key names one table, and `source_id` names four depending on `source_type`. Triggers are the
-- only mechanism the schema admits, which is also why the serve side now checks liveness too
-- (`vector-search.ts`) — a trigger cannot fire for a row lost to `DROP TABLE`, so cleanup alone
-- can only promise "clean right now", never "cannot serve".
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. THE MISSING CASCADE ──────────────────────────────────────────────────────────────
-- Same shape and same idiom as `081`'s two, so the three lanes read identically. `briefing` gets
-- none on purpose: nothing writes one, and a trigger on a table with no producer is a claim
-- rather than a guard. The declared map in `memory/embeddings.ts` covers it on the serve side,
-- and its completeness census is what will fail if a producer ever appears.
CREATE TRIGGER IF NOT EXISTS techniques_embed_ad AFTER DELETE ON techniques BEGIN
  DELETE FROM embeddings WHERE source_type = 'technique' AND source_id = old.id;
END;

-- ── 2. THE SWEEP ────────────────────────────────────────────────────────────────────────
-- Per kind and by NAME, never a blanket "delete anything whose source is missing". A kind this
-- migration has not heard of must survive it: silently deleting the embeddings of a source type
-- added after this file was written is exactly the unrecoverable damage a sweep must not risk.
-- `081` swept `message` alone; the two below are the lanes still holding rows.

DELETE FROM embeddings
 WHERE source_type = 'message'
   AND source_id NOT IN (SELECT id FROM messages);

DELETE FROM embeddings
 WHERE source_type = 'summary'
   AND source_id NOT IN (SELECT id FROM summaries);

DELETE FROM embeddings
 WHERE source_type = 'technique'
   AND source_id NOT IN (SELECT id FROM techniques);

DELETE FROM embeddings
 WHERE source_type = 'briefing'
   AND source_id NOT IN (SELECT id FROM briefings);
