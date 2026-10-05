-- 180 (W2-B item G): THE SWEEP THAT A SINGLE NULL ID WOULD HAVE TURNED INTO A NO-OP.
--
-- `175_orphaned_embeddings.sql` swept the four polymorphic `embeddings` lanes with
-- `source_id NOT IN (SELECT id FROM <source table>)`. THREE of those four `id` columns are a
-- bare `id TEXT PRIMARY KEY`, and SQLite's PRIMARY KEY does NOT imply NOT NULL outside a STRICT
-- table — which none of these are. Measured at this head with `PRAGMA table_info`:
--
--   messages.id    notnull=1   PROTECTED — the `127`/`131`/`132`/`133` rebuilds made it NOT NULL
--   summaries.id   notnull=0   EXPOSED
--   techniques.id  notnull=0   EXPOSED
--   briefings.id   notnull=0   EXPOSED
--
-- So the backlog line names exactly the right three, and the `message` lane — by far the
-- largest, 44,883 rows at `175`'s own count — is already safe. Those three statements rested on
-- an assumption about WRITERS, not on anything the schema enforces. The `messages` row is also
-- the useful precedent: NOT NULL arrived there as a side effect of a rebuild done for other
-- reasons, which is the only way this tree has ever paid for one.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ WHY THAT MATTERS, AND IT IS THE QUIET DIRECTION OF THE BUG.
--
-- `x NOT IN (SELECT id FROM t)` is `NOT (x = id1 OR x = id2 OR …)`. One NULL in that list makes
-- every comparison UNKNOWN, so the whole predicate is UNKNOWN for EVERY row, and the DELETE
-- removes NOTHING. Measured, on the real column shapes:
--
--   a NULL `id` inserted into a bare `TEXT PRIMARY KEY`   ACCEPTED
--   a SECOND NULL id in the same table                    ACCEPTED (NULLs are not equal, so
--                                                         the PK does not dedupe them either)
--   `NOT IN` sweep with one NULL in the subquery           deleted 0 of 2 doomed rows
--   `NOT EXISTS` over the identical body                   deleted 2 of 2
--
-- It never eats a row it should have kept. It SILENTLY KEEPS rows it should have eaten — and
-- `175` is a one-shot, so if any of those four tables held a NULL id on the boot that applied
-- it, that lane reported success and cleaned nothing, and nothing will ever retry it.
--
-- `176_orphaned_work_references.sql`, written days later, chose `NOT EXISTS` deliberately and
-- said why in its own header. `175` is the last residue sweep still carrying the old spelling.
-- This migration is the same four lanes asked the safe way. It is a REPAIR of a possible silent
-- no-op, not a new policy.
--
-- ── WHY NOT A `CHECK (id IS NOT NULL)` INSTEAD, which is the other obvious fix ──
-- Because the exposure is not these three tables. Censused from the migrated schema: FORTY-TWO
-- tables declare a nullable `id TEXT PRIMARY KEY`, including `work`, `agents`, `audit_log`,
-- `deliveries` and `conversations`. A CHECK cannot be added to an existing table without a full
-- rebuild, and a rebuild is the highest-ceremony migration shape in this tree — `138` and `142`
-- show what one costs for a single table. Forty-two of them, to defend against a failure mode
-- whose entire damage is "a sweep silently does nothing", is the wrong trade. The guard that
-- actually closes it is the PREDICATE, which is free: no reachable sweep may use `NOT IN` over a
-- nullable column, and `db/__tests__/a-null-id-silences-a-sweep.test.ts` censuses every
-- `NOT IN (SELECT …)` site in the tree against a pinned list so a new one fails before it ships.
-- That clause also pins the nullability of all four columns above, so the day one of the three
-- gains a CHECK or its table becomes STRICT, the clause says the exposure is gone rather than
-- going quietly stale.
--
-- ── WHAT IT TOUCHES ──
--   * an `embeddings` row whose `source_type` is one of the four lanes `175` named (all four are
--     re-swept, not just the three exposed ones: the `message` lane costs nothing to re-ask and
--     a sweep that covers three of four invites the next reader to wonder which), and whose
--     `source_id` matches no row in that lane's table                        -> DELETED
--   * an `embeddings` row of ANY OTHER `source_type`                         -> UNTOUCHED
--   * an `embeddings` row whose source EXISTS                                -> UNTOUCHED
--
-- Per kind and BY NAME, never a blanket "delete anything whose source is missing" — `175`'s own
-- rule, kept verbatim: a source type added after this file was written must survive it, because
-- silently deleting a new kind's embeddings is unrecoverable damage a sweep must not risk.
--
-- A NULL `source_id` cannot exist here (`embeddings.source_id` IS declared `NOT NULL`), so there
-- is no NULL case on the LEFT of these predicates to reason about — the exposure was only ever
-- the subquery side, which is what `NOT EXISTS` removes.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- ⚠ DESTRUCTIVE, and only of rows already unreachable. `memory/vector-search.ts` checks source
-- liveness on the serve side, so a row naming a source that does not exist is never served; it
-- is dead weight in the index and nothing else.
--
-- `NOT EXISTS` has no NULL semantics to get wrong: it asks whether a matching row exists, and a
-- NULL `id` in the source table simply fails to match, which is correct — an embedding whose
-- source row has a NULL id names nothing findable either.
--
-- No JSON function, no CHECK re-evaluated by a delete, no column value parsed, so it cannot
-- RAISE on a row of any shape. No DDL, no index, no trigger, no table rebuild — so `applyOne`'s
-- one-transaction-per-file wrapper holds. Not a `<NNN>b` bridge file.
--
-- IDEMPOTENT BY ITS PREDICATES, not by the `_migrations` marker: after the first run nothing
-- matches. A fresh install applies all four against empty tables and is correct.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITER: this file, once. Going forward the triggers `081` and `175` installed
-- (`messages_embed_ad`, `summaries_embed_ad`, `techniques_embed_ad`) keep three of the four
-- lanes swept, and `memory/embeddings.ts`'s `INSERT … SELECT … WHERE EXISTS` stops the
-- write-after-delete race that minted them. READERS of the rows removed: none —
-- `vector-search.ts` already refuses to serve them. Guarded by
-- `db/__tests__/a-null-id-silences-a-sweep.test.ts`.

-- ── 1-4. THE FOUR LANES, ASKED THE WAY A NULL CANNOT ANSWER FOR ──
DELETE FROM embeddings
 WHERE source_type = 'message'
   AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id = embeddings.source_id);

DELETE FROM embeddings
 WHERE source_type = 'summary'
   AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.id = embeddings.source_id);

DELETE FROM embeddings
 WHERE source_type = 'technique'
   AND NOT EXISTS (SELECT 1 FROM techniques s WHERE s.id = embeddings.source_id);

DELETE FROM embeddings
 WHERE source_type = 'briefing'
   AND NOT EXISTS (SELECT 1 FROM briefings s WHERE s.id = embeddings.source_id);
