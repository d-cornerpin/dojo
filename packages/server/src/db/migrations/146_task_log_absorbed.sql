-- ════════════════════════════════════════════════════════════════════════════════════════
-- 146 — `task_log` IS ABSORBED INTO THE SPINE AND DROPPED.  PHASE-2 T10G, RULING 10.
--
-- verdict: REKEY.
-- requirement preserved: THE ONE HISTORY THE OWNER READS — every touch on a tracker row,
--   in one place, newest first: who did it, what kind of touch, what moved, why, what they
--   did, and what they wrote. Rendered by `formatEntryLine` into three surfaces, all of
--   which still read it: the Activity panel (`dashboard/src/pages/Tracker.tsx:293`), the
--   PM's ledger line (`tracker/pm-agent.ts`), and the agent context block
--   (`memory/assembler.ts`). Plus the four derived readings the PM does off the same trail
--   (paused-task receipts, the pause-resume thrash count, the pause reason, goal-edit
--   history) and the `/hygiene` panel's validate/reject rates and smell-flag histogram.
--
-- THIS IS NOT A COPY. It is a DE-DUPLICATION, and every disposition below is a measurement
-- taken at HEAD on the live box before this file was written (#14). RULING 10 ruled the
-- shape; the numbers are why it ruled that way.
--
-- ── THE 110 `transition` ENTRIES, IN THREE CLASSES ──
--
--   40 MOVED a row AND have a spine `transition` event on the same work within 3 s.
--      NOT CARRIED — a tombstone mapping instead. Two records of one fact, written by two
--      writers in two vocabularies; the spine's is strictly richer (`from`/`to`/`by`/
--      `reason`/`evidence_ref`/`result_delivery_id`/`claim`/`note`) and is written INSIDE
--      the state-change transaction, where this table's copy was best-effort and outside it.
--      The window is not a guess: the count is 40 at 1 s, 40 at 3 s, 40 at 10 s, 40 at 60 s
--      and 41 at 5 minutes. A boundary that does not move across four orders of magnitude is
--      a real boundary, so 3 s is the tolerance and the one row at 5 minutes is deliberately
--      carried rather than matched on a window nothing else supports.
--
--   59 DID NOT MOVE A ROW AT ALL — `from_status IS to_status`. Every single one is
--      `from_entity='pm'` and every single one is a PM validation (`valid=true`): 34
--      `tracker_validate(kind=complete)`, 24 `work_validate(kind=complete)`, 1
--      `work_validate(kind=pause)`. They are ADJUDICATIONS WEARING A TRANSITION LABEL.
--      NOT CARRIED, and this is the finding that changed the job: THEY ARE ALREADY IN
--      `adjudications`, written live by the product. Proven four ways, not assumed —
--        * the two work sets are IDENTICAL: 51 works on each side, ZERO on either side the
--          other lacks (`nm NOT in adj` = 0 and `adj NOT in nm` = 0);
--        * 51 of the 59 entries sit within 3 s of an adjudication row on the same work;
--        * 50 of the 51 works already read `done_validated = 1` through `validatedExpr`,
--          and the one that does not is the `paused` blessing, correctly excluded by a
--          `done`-scoped predicate — it has its own `paused/upheld` adjudication;
--        * `upholdClaim` writes the `adjudications` row AND a `claim_upheld` event, so the
--          trail has an audit-shaped record of it too.
--      RULING 10 said to record these as what they ARE. The product already did. INSERTING
--      would be the double-recording the same ruling forbids — and it would be worse than
--      redundant: `validatedExpr` reads `adjudications` to decide whether the PM's key is
--      turned, so 59 manufactured verdicts would have MOVED A LIVE PREDICATE. The ruling's
--      `provenance='migrated'` is therefore not written anywhere, because nothing is
--      migrated; `adjudications` has no `provenance` column and does not need one.
--
--   11 MOVED a row and have NO spine twin at ANY window (8 of their works have no spine
--      `transition` event at all): 8 × `in_progress → complete` closed by an agent, and 3
--      scheduler moves (`on_deck → in_progress` ×2, `in_progress → fallen` ×1). They
--      predate the cutover that made `transition()` the one writer. CARRIED — history
--      nothing else holds, and #15 forbids resting a removal on an absence.
--
-- ── THE OTHER 55 ENTRIES ── 38 `observation` + 17 `directive`, prose the owner and the PM
--    read ("Both fanout agents are terminated and no codeword artifacts found on disk…").
--    `work_events` has NO `observation` and NO `directive` kind, so there is no counterpart
--    and nothing to de-duplicate. ALL CARRIED.
--
-- ── WHY EVERYTHING LANDS AS ONE KIND, `audit` ──
--    The trail's entry kinds collide BY NAME with spine event kinds — `transition`, `poke`,
--    `user_verdict_request` — and those names are read by LIVE PREDICATES (`lastEntryInto`
--    inside `validatedExpr`, `awaitingUserVerdictExpr`, the poke ladder). Carrying the trail
--    under those names would let a migrated audit line answer a predicate that decides
--    whether work counts as validated: a behaviour change smuggled in as a storage change,
--    which is the call T8T RESUMED-2 refused when it declined to file an adjudication for a
--    denial. So the trail is `kind='audit'` with its own `entry_kind` inside the payload.
--    In particular the 11 carried transitions do NOT become `kind='transition'` rows: 8 of
--    their works have no spine transition at all, so `lastEntryInto` would go from NULL to
--    an old instant and `validatedExpr`'s `created_at >=` window would TIGHTEN — flipping
--    validated rows to unvalidated. Measured hazard, avoided by construction.
--
-- ── THE THREE MECHANICAL MISMATCHES, each handled here rather than discovered later ──
--    * `task_log.created_at` is `datetime('now')` TEXT (UTC, second resolution);
--      `work_events.created_at` is epoch ms INTEGER. `strftime('%s', …) * 1000` converts,
--      and `tracker-view.ts:msToText` converts back for display, so the panel's line keeps
--      its exact shape. Second resolution in, second resolution out — nothing is invented.
--    * `writeTaskLog` returned a uuid TEXT; `work_events.id` is INTEGER. The seam returns
--      `String(id)`, so `POST /tasks/:id/observation`'s `{entryId}` stays a string and the
--      dashboard's type is unchanged (it stores the value and reads it nowhere).
--    * the trail rendered TRACKER vocabulary (`in_progress → blocked`) and the spine event
--      says SPINE vocabulary (`claimed → blocked`). RULING 10: map by T2's own CASE
--      precedent. `STATE_TO_STATUS_SQL` does it in the reader, so this is a re-point of an
--      existing mapping and not an invention. The 11 carried rows keep the tracker words
--      they were written with.
--
-- FAIL-SAFE FOR A BODY WHOSE DATA DIFFERS. The 59-are-already-adjudicated finding is a fact
-- about the bodies measured, not a law. So the non-moving branch does not blanket-skip: it
-- carries any non-moving transition whose work has NO adjudication at all. On this box that
-- selects zero rows; on a body where the correspondence does not hold, the entry is
-- preserved instead of silently dropped. RULING 10's "BLOCKED if the data resists" is thus
-- expressed as a branch rather than as a hope.
--
-- NOT RE-RUNNABLE, deliberately, and consistent with `144`/`145`: the carries read the table
-- that step 4 drops, so a second manual apply fails loudly with `no such table: task_log`.
-- `applyOne` records the name inside the same transaction as the apply, so a crash rolls the
-- whole thing back and a retry does it exactly once. After MAP-TRIAGE, a manual re-run that
-- fails loudly is the right direction.
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. the prose: observation / directive / and any other non-transition kind ──
-- Kept general on purpose. Ten of the thirteen declared kinds have live WRITE SITES and zero
-- rows on this box (`auto_sweep` 7 sites, `override` 6, `reject` 4, `smell_flag` 2,
-- `user_verdict_request` 2, `user_verdict_applied` 1, `closeout_miss` 1). A branch that named
-- only the two kinds that happen to have rows here would drop them on any body that has any.
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT tl.task_id, 'audit',
       json_object(
         'entry_kind',    tl.entry_kind,
         'from_status',   tl.from_status,
         'to_status',     tl.to_status,
         'reason',        tl.reason,
         'action_taken',  tl.action_taken,
         'note',          tl.note,
         'evidence_json', tl.evidence_json,
         'provenance',    'migrated',
         -- HOTFIX-144 sweep: an instant this schema cannot read is PRESERVED VERBATIM here
         -- rather than lost with the table. `null` on every row whose instant converted,
         -- which is every row on every body measured.
         'created_at_raw', CASE WHEN strftime('%s', tl.created_at) IS NULL
                                THEN tl.created_at END),
       tl.from_entity,
       -- HOTFIX-144 sweep, and the scope of it is a MEASUREMENT rather than a worry (#14).
       -- A MISSING instant is UNREPRESENTABLE here and I checked rather than assumed: the
       -- source DDL at `009_phase6.sql:47` is `TEXT DEFAULT (datetime('now'))` with no NOT
       -- NULL, but `138_repoint_side_table_fks.sql` REBUILDS this table as
       -- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`, and `138` sorts before this
       -- file. Planting a NULL is refused by the engine.
       -- AN UNREADABLE instant is a different question and is NOT excluded: NOT NULL does not
       -- mean parseable, and any TEXT `strftime` cannot read converts to NULL exactly as a
       -- missing one would. `work_events.created_at` is NOT NULL, so that made this
       -- expression NULL and aborted the file — and on a real box a migration abort is a BOOT
       -- abort. 0 such rows on every body we hold, and legal on all of them.
       -- The entry is still CARRIED: "it happened" is the fact and the instant is the detail
       -- (`135`'s clamp and `144`'s ladder make the same call), dated at its own work row's
       -- opening instant, which `work` guarantees NOT NULL.
       COALESCE(strftime('%s', tl.created_at) * 1000,
                (SELECT w2.opened_at FROM work w2 WHERE w2.id = tl.task_id))
  FROM task_log tl
 WHERE tl.entry_kind <> 'transition'
   AND EXISTS (SELECT 1 FROM work w WHERE w.id = tl.task_id);

-- ── 2. the moving transitions the spine never recorded ──
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT tl.task_id, 'audit',
       json_object(
         'entry_kind',    'transition',
         'from_status',   tl.from_status,
         'to_status',     tl.to_status,
         'reason',        tl.reason,
         'action_taken',  tl.action_taken,
         'note',          tl.note,
         'evidence_json', tl.evidence_json,
         'provenance',    'migrated',
         -- HOTFIX-144 sweep: an instant this schema cannot read is PRESERVED VERBATIM here
         -- rather than lost with the table. `null` on every row whose instant converted,
         -- which is every row on every body measured.
         'created_at_raw', CASE WHEN strftime('%s', tl.created_at) IS NULL
                                THEN tl.created_at END),
       tl.from_entity,
       -- HOTFIX-144 sweep, and the scope of it is a MEASUREMENT rather than a worry (#14).
       -- A MISSING instant is UNREPRESENTABLE here and I checked rather than assumed: the
       -- source DDL at `009_phase6.sql:47` is `TEXT DEFAULT (datetime('now'))` with no NOT
       -- NULL, but `138_repoint_side_table_fks.sql` REBUILDS this table as
       -- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`, and `138` sorts before this
       -- file. Planting a NULL is refused by the engine.
       -- AN UNREADABLE instant is a different question and is NOT excluded: NOT NULL does not
       -- mean parseable, and any TEXT `strftime` cannot read converts to NULL exactly as a
       -- missing one would. `work_events.created_at` is NOT NULL, so that made this
       -- expression NULL and aborted the file — and on a real box a migration abort is a BOOT
       -- abort. 0 such rows on every body we hold, and legal on all of them.
       -- The entry is still CARRIED: "it happened" is the fact and the instant is the detail
       -- (`135`'s clamp and `144`'s ladder make the same call), dated at its own work row's
       -- opening instant, which `work` guarantees NOT NULL.
       COALESCE(strftime('%s', tl.created_at) * 1000,
                (SELECT w2.opened_at FROM work w2 WHERE w2.id = tl.task_id))
  FROM task_log tl
 WHERE tl.entry_kind = 'transition'
   AND tl.from_status IS NOT tl.to_status
   AND EXISTS (SELECT 1 FROM work w WHERE w.id = tl.task_id)
   AND NOT EXISTS (
     SELECT 1 FROM work_events we
      WHERE we.work_id = tl.task_id
        AND we.kind = 'transition'
        AND abs(we.created_at - strftime('%s', tl.created_at) * 1000) <= 3000);

-- ── 3. the fail-safe: a NON-moving transition on work that carries no verdict at all ──
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT tl.task_id, 'audit',
       json_object(
         'entry_kind',    'claim_upheld',
         'from_status',   tl.from_status,
         'to_status',     tl.to_status,
         'reason',        tl.reason,
         'action_taken',  tl.action_taken,
         'note',          tl.note,
         'evidence_json', tl.evidence_json,
         'provenance',    'migrated',
         -- HOTFIX-144 sweep: an instant this schema cannot read is PRESERVED VERBATIM here
         -- rather than lost with the table. `null` on every row whose instant converted,
         -- which is every row on every body measured.
         'created_at_raw', CASE WHEN strftime('%s', tl.created_at) IS NULL
                                THEN tl.created_at END),
       tl.from_entity,
       -- HOTFIX-144 sweep, and the scope of it is a MEASUREMENT rather than a worry (#14).
       -- A MISSING instant is UNREPRESENTABLE here and I checked rather than assumed: the
       -- source DDL at `009_phase6.sql:47` is `TEXT DEFAULT (datetime('now'))` with no NOT
       -- NULL, but `138_repoint_side_table_fks.sql` REBUILDS this table as
       -- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`, and `138` sorts before this
       -- file. Planting a NULL is refused by the engine.
       -- AN UNREADABLE instant is a different question and is NOT excluded: NOT NULL does not
       -- mean parseable, and any TEXT `strftime` cannot read converts to NULL exactly as a
       -- missing one would. `work_events.created_at` is NOT NULL, so that made this
       -- expression NULL and aborted the file — and on a real box a migration abort is a BOOT
       -- abort. 0 such rows on every body we hold, and legal on all of them.
       -- The entry is still CARRIED: "it happened" is the fact and the instant is the detail
       -- (`135`'s clamp and `144`'s ladder make the same call), dated at its own work row's
       -- opening instant, which `work` guarantees NOT NULL.
       COALESCE(strftime('%s', tl.created_at) * 1000,
                (SELECT w2.opened_at FROM work w2 WHERE w2.id = tl.task_id))
  FROM task_log tl
 WHERE tl.entry_kind = 'transition'
   AND tl.from_status IS tl.to_status
   AND EXISTS (SELECT 1 FROM work w WHERE w.id = tl.task_id)
   AND NOT EXISTS (SELECT 1 FROM adjudications a WHERE a.work_id = tl.task_id);

-- ── 4. the table goes ──
DROP INDEX IF EXISTS idx_task_log_task_id;
DROP INDEX IF EXISTS idx_task_log_kind;
DROP INDEX IF EXISTS idx_task_log_entity;
DROP TABLE task_log;
