-- 189e (v3.3.3 t142, fix round 1, review M1): EVERY BACKFILLED VERDICT POSITION IS RECOMPUTED
-- SO THAT NONE CAN READ AS CURRENT AFTER A LATER RE-ENTRY.
--
-- WHAT 189c GOT WRONG, for one shape only. A verdict with NO companion event on file was given
-- either the first event "at or after its instant" of a companion KIND for its state — which,
-- with no real companion, can be a LATER re-entry into that state — or, failing that, the
-- GLOBAL MAX(id). Either way such a verdict read as validating an entry that happened after it,
-- where base (comparing clocks) read it unvalidated. No shipped writer produces a verdict
-- without a companion (each files the verdict and its event in one unit), so this was reachable
-- only by a clock stepping backwards between two `now()` readings — but "unreachable today"
-- is a claim about writers, and a migration should not depend on it. 189c is not amended (the
-- freeze gate); this file supersedes its positions.
--
-- THE RULE, per verdict, the companion read the way each writer actually writes it:
--   · a `transition` into the verdict's state AT EXACTLY ITS INSTANT (`transition()` gives the
--     verdict and its event one `at`), or
--   · a `claim_upheld` (for an upheld verdict) / `claim_rejected` (for a rejected one) on that
--     state AT OR AFTER its instant (`upholdClaim` / `rejectClaim` read the clock twice);
--   · the first such row is the position. If none exists, the verdict is placed at the work's
--     own CLOCK FLOOR — the newest event on that work at or before its instant (0 if none) —
--     which reproduces base's answer exactly: an entry before the verdict is <= the floor
--     (validated), an entry after it is > the floor (not).
-- Matching a claim_* row only of the verdict's OWN kind matters: an upheld verdict without a
-- companion parked on some later REJECTION's row would read current for an entry before it.
-- A later uphold's row is harmless — that uphold validates the same entries itself.
--
-- THE FLOOR IGNORES 189d's CARRY ROWS. A carry has a NEW id but the OLD stamp's instant (that is
-- what keeps the dashboard label still), so a clock floor that could see it would park a verdict
-- filed after the carried stamp ABOVE a later re-entry — the leak-forward this file exists to end,
-- reintroduced by the file before it (re-review 1, N1; rehearsed in vintage D). A carry is not
-- history the verdict was filed into; it is bookkeeping written at upgrade time.
--
-- Every json_extract is behind json_valid (189c's rehearsal finding).

UPDATE adjudications
   SET event_seq = COALESCE(
     (SELECT MIN(e.id) FROM work_events e
       WHERE e.work_id = adjudications.work_id
         AND (   (e.kind = 'transition'
                  AND e.created_at = adjudications.created_at
                  AND CASE WHEN json_valid(e.payload)
                           THEN json_extract(e.payload, '$.to') END = adjudications.claim_state)
              OR (e.kind = CASE adjudications.verdict WHEN 'upheld' THEN 'claim_upheld'
                                                      ELSE 'claim_rejected' END
                  AND e.created_at >= adjudications.created_at
                  AND CASE WHEN json_valid(e.payload)
                           THEN json_extract(e.payload, '$.claim_state') END = adjudications.claim_state))),
     (SELECT COALESCE(MAX(f.id), 0) FROM work_events f
       WHERE f.work_id = adjudications.work_id
         AND f.created_at <= adjudications.created_at
         AND f.actor <> 'migration-189d'));
