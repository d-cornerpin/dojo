-- 159 (UX-REPAIR ROUND 6 T25): `owed_interrupt` JOINS THE DECLARED work_events KINDS.
--
-- WHY A NEW KIND AND NOT A PAYLOAD FLAG. The owed mid-turn interrupt
-- (`agent/v2/steps/post-call-classify/owed-interrupt.ts`) already knows which asks a running
-- turn owes an answer to — it holds the message rows and quotes them into a re-prompt — and
-- then keeps only the QUOTED PROSE. Settlement, three seconds later on the same turn, closed
-- one of those asks on the OTHER ask's delivery (agent 57b52025, 2026-08-10 23:01:18: seq
-- 60569 "quick one — what's 15% of $240?" closed on delivery 6a20d864, the e-ink research
-- bubble; the real answer landed at 23:03:25 from the next turn). Two engine mechanisms,
-- opposite verdicts, and the ledger took the wrong one because the right one had recorded
-- nothing a predicate could read.
--
-- The fix is that the mechanism records its subjects BY ID, on the asks' own spine, so the
-- discriminator is a receipt rather than a text match. A payload flag on `audit` would have
-- been invisible to exactly the kind of predicate that needs it: `work/audit-trail.ts`'s own
-- header records that `kind='audit'` is read in ONE module and nowhere else, precisely so
-- nothing filed there can answer a predicate that decides an outcome. This decides one.
--
-- THE LIST ONLY GROWS HERE, so there is no quarantine step: every row that satisfied 152's
-- CHECK satisfies this one. `work/event-kinds.ts` carries the same 26 values and
-- `work/__tests__/work-event-kinds-conformance.test.ts` asserts the two are set-equal in both
-- directions, so neither can move alone.
--
-- THE REBUILD is 152's, verbatim in shape, and for its reasons: SQLite has no ADD CONSTRAINT.
-- Re-verified against the live schema before writing this file — `work_events` still carries
-- no indexes, no triggers, no views and no inbound `REFERENCES`, so nothing has to be
-- re-created after the rename. `id` is copied EXPLICITLY (the poke ladder bounds its cycle on
-- `work_events.id`, so renumbering would silently break it) and the AUTOINCREMENT counter is
-- carried by hand, for the reason 152 states: a rebuild silently resets it, and AUTOINCREMENT's
-- contract is that a deleted row's id is never handed out again.

CREATE TABLE work_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
    'compile_resolved','floor_ghosted','join_complete','join_opened','occurrence_fired',
    'occurrence_released','occurrence_settled','opened','override_request','override_resolved',
    'owed_interrupt','poke','poke_remediation','rearm_refused','revert_reset','transition',
    'user_verdict_cleared','user_verdict_requested','validation_escalated','validation_requested'
  )),
  payload TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO work_events_new (id, work_id, kind, payload, actor, created_at)
SELECT id, work_id, kind, payload, actor, created_at FROM work_events;

UPDATE sqlite_sequence
   SET seq = (SELECT MAX(seq) FROM sqlite_sequence WHERE name IN ('work_events', 'work_events_new'))
 WHERE name = 'work_events_new';

DROP TABLE work_events;
ALTER TABLE work_events_new RENAME TO work_events;
