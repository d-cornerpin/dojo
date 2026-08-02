-- 151 (PHASE-4 T2): A `done` WORK ROW MAY NOT SILENTLY LOSE ITS EVIDENCE.
--
-- WHAT WAS BROKEN, and it is not the absence of a rule — it is the absence of an
-- ENFORCEMENT POINT for a rule already stated three times:
--
--   * migration 135:      CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)
--   * work/store.ts G7:   the id must point at a delivery that EXISTS
--   * this very column:   result_delivery_id TEXT REFERENCES deliveries(id)
--
-- Every one of those is satisfied by a database in which the delivery has SINCE been
-- deleted. The CHECK only ever sees the column. G7 looks once, at close time. And the
-- FK — the only one that keeps looking — is enforced by `PRAGMA foreign_keys`, which is
-- PER CONNECTION and defaults to OFF. This tree already knew that and wrote it down
-- (memory/message-store.ts: "FK enforcement is a per-connection PRAGMA, and it is OFF
-- for the whole migration chain"); nobody drew the consequence for this column.
--
-- MEASURED, not argued. One DELETE on a VACUUM INTO copy of the real dev body, twice:
--   foreign_keys = ON    -> "FOREIGN KEY constraint failed"; the row survives
--   foreign_keys = OFF   -> the delete succeeds, and 180 `done` rows are orphaned
-- Which is exactly how the dev body came to hold SEVEN `done` rows pointing at
-- deliveries that no longer exist: the behavioural harness's teardown deletes a swept
-- peer's `deliveries` rows through the `sqlite3` CLI, where the pragma is off, while its
-- `work` DELETE is deliberately narrowed and does not take the rows that named them.
-- A closed ticket became unprovable and nothing anywhere refused.
--
-- WHY A TRIGGER, not a stronger FK. `ON DELETE RESTRICT` would need a full rebuild of
-- `work` (sixty-odd columns, its CHECKs, its triggers and its indexes) and would STILL be
-- pragma-scoped, i.e. the same guard with the same hole. A trigger is smaller and cannot
-- be switched off by a connection setting: SQLite has no pragma that disables one.
--
-- WHY REFUSE, not re-point. The other shape on offer was to move `result_delivery_id`
-- onto a tombstone delivery saying "the evidence used to be here". That MANUFACTURES the
-- receipt the law asks for — the forged-completion class migration 108 was demolished
-- for, and the prose-keyed honesty this phase's cautions forbid. A closed ticket is
-- provable or it is not closed. The refusal carries a sentence a human can act on rather
-- than a bare constraint name.
--
-- WHY `state = 'done'` ONLY. A non-terminal row's `result_delivery_id` is not the
-- evidence of anything — nothing has been claimed about it — so deleting it tells no
-- lie. A guard that bites wider than its requirement is a guard the next person turns
-- off, and there is no `ON DELETE` behaviour here to preserve for the other states.
--
-- SAFE ON A LIVED-IN BODY, BY CONSTRUCTION rather than by luck — and that is the whole
-- reason this is a trigger rather than the CHECK the same idea would suggest. A BEFORE
-- DELETE trigger validates NOTHING at creation time, so a database that already contains
-- orphans (this one contains seven) takes the chain without a murmur; only future
-- deletes are refused. That is the opposite risk profile to the "new constraint born on
-- a live column" class the `.23` incident belongs to, and it is asserted rather than
-- assumed: db/__tests__/migration-151-delivery-evidence.test.ts runs the whole chain over
-- a planted orphan body and reads the row still there afterwards.
--
-- THE BLAST RADIUS, enumerated by command before this was written (#15 — no deletion or
-- constraint resting on an absence):
--   git grep -n "DELETE FROM deliveries" -- packages/ watchdog/    -> ONE hit, a test
--   grep -rn "deliveries" src/db/migrations/*.sql | grep -iE "delete|drop"  -> none
-- So nothing in the product or the chain deletes from this table today. The one caller
-- that does is the test harness, outside this repo, and it is corrected in the same task
-- (roadmap non-negotiable #4: the harness is part of the blast radius).

CREATE TRIGGER IF NOT EXISTS deliveries_done_evidence_no_delete
BEFORE DELETE ON deliveries
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM work w
   WHERE w.result_delivery_id = OLD.id
     AND w.state = 'done'
)
BEGIN
  SELECT RAISE(
    ABORT,
    'refused: this delivery is the evidence of a done work row. Work is done because something was delivered; deleting the receipt would make a closed ticket unprovable. Reopen or abandon the work row first, then delete.'
  );
END;
