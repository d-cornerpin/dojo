-- 139 (PHASE-2 T8T): TWO-KEY COMPLETION BECOMES STRUCTURAL.
--
-- WHAT THIS IS. Research 19 §1c (MAP:897-921) asked for one trigger: a work item cannot
-- reach completion without an upheld adjudication. This is that trigger, in the shape the
-- orchestrator RULED (PHASE-2 progress.md, RULING 1, 2026-07-29) after PHASE-2 T8a proved
-- the verbatim lift unlandable.
--
-- WHY NOT VERBATIM, MEASURED RATHER THAN ARGUED. The MAP's subject was `work_item`, a
-- TRACKER noun. OR1 widened the TABLE, not the rule: asks, commitments, occurrences and the
-- fan-out join's pieces all live in `work` now. Measured on the dev box at T8a
-- (`SELECT kind, state, count(*) FROM work GROUP BY 1,2` against
-- `SELECT count(*) FROM adjudications`): 83 `ask` rows had reached `done` and the
-- adjudications table held ZERO rows. An unscoped trigger aborts every ask closure T3/T5
-- built, and every commitment resolution T7 built, on the first write. Hence
-- `NEW.kind IN ('task','project')` — the MAP's actual subject restored.
--
-- AND THE SAME ARGUMENT ONE KIND FURTHER IN, found by the rehearsal rather than reasoned
-- about. `kind='task'` is not the same set as "the tracker's rows": PHASE-2 T4's fan-out
-- opens its countdown children as `kind='task'` too (`store.ts:openDelegationJoin`, ids
-- shaped `piece:<parent>:<thread>`), and `store.ts:landPiece` settles each one with
-- `by: 'agent'` when the peer's answer comes back. Measured on this box:
-- `SELECT kind, root_kind, count(*) FROM work GROUP BY 1,2` → **17 `task` rows carry
-- `root_kind='a2a_thread'`**. A trigger scoped on `kind` alone aborts every one of those
-- landings — the identical defect as the ask case, one level down. `tracker-view.ts:104-112`
-- already says these in writing: *"pieces of an ask, not board rows"*. So the trigger carries
-- the discriminator the board's own predicate carries.
--
-- The exclusion is NEGATIVE (`<> 'a2a_thread'`) where `taskScope` is positive
-- (`IN ('legacy','tracker','engine_scaffold')`), and that asymmetry is deliberate: a guard
-- should fail CLOSED. A `root_kind` nobody has invented yet gets bitten and someone finds out
-- loudly, which is the opposite of the silence this trigger exists to end. `root_kind` is
-- `NOT NULL` (`135_work_spine.sql:46`), so the comparison has no third answer.
--
-- WHAT TURNS THE SECOND KEY. `work/store.ts:transition()` files the `claim_state='done'`
-- adjudication INSIDE the same transaction as the state change (and BEFORE the UPDATE, so
-- this BEFORE-UPDATE trigger can see it) when the closer is:
--   * an authority — `owner` or `pm`, carrying `claim: 'authoritative'`; or
--   * a system closer — `engine`, `scheduler` or `healer`, whose close gate G7 has already
--     forced to point at a `deliveries` row that EXISTS.
-- The AGENT's own close files nothing: gate G9 records it as a Key-1 request
-- (`work_events.kind='validation_requested'`) and the row does not move. That is the whole
-- ruling — a worker no longer closes its own work on its own say-so.
--
-- WHY A TRIGGER AND NOT ONLY THE GATE. The gate is the steerable half; this is the half that
-- cannot be forgotten. `work.state` has exactly one writer today (proven by
-- `work/__tests__/single-writer-conformance.test.ts`), and this trigger is what makes that
-- proof survive the next writer somebody adds in two years — the same reason G7's delivery
-- requirement is BOTH a CHECK constraint and a gate.
--
-- FRESHNESS IS DELIBERATELY NOT IN HERE. The window ("this close's verdict, not the one
-- before the retask") lives in `work/tracker-view.ts:validatedExpr`, where the flag columns
-- it replaced always kept it. Putting it in the trigger as well would tie the DDL to one
-- caller's timestamp discipline and buy nothing: a stale upheld row cannot let an agent
-- through (G9 refuses on the closer, not on the adjudication), and every system/authority
-- close files its own fresh row in the same transaction. Asserted in
-- `work/__tests__/two-key-completion.test.ts` §4.
--
-- SCOPE OF THE BITE, stated so nobody has to infer it:
--   * UPDATE only. An INSERT of a `done` row is not a close — migration `135`'s backfill and
--     `138`'s adoption both write `state='done'` rows directly and must keep working.
--   * `UPDATE OF state` only. The stamp/patch surface (`patchWork`, the countdown decrement,
--     `compile_pending`) does not name `state` and never fires this.
--   * `OLD.state <> 'done'` — a re-write of an already-done row is not a close either.
--
-- REVERSIBILITY. `DROP TRIGGER IF EXISTS` first, so a re-run is a no-op rather than an error
-- (`db/migrations.ts` runs each file once, but the Bridge path may replay).
DROP TRIGGER IF EXISTS two_key_completion;

CREATE TRIGGER two_key_completion
BEFORE UPDATE OF state ON work
WHEN NEW.state = 'done'
 AND OLD.state <> 'done'
 AND NEW.kind IN ('task', 'project')
 AND NEW.root_kind <> 'a2a_thread'
BEGIN
  SELECT RAISE(ABORT, 'two-key: completion requires an upheld adjudication')
  WHERE NOT EXISTS (
    SELECT 1 FROM adjudications adj
     WHERE adj.work_id = NEW.id
       AND adj.claim_state = 'done'
       AND adj.verdict = 'upheld'
  );
END;
