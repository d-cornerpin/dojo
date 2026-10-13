-- 189 (v3.3.3 t142): `person_told` JOINS THE DECLARED work_events KINDS — "a person was told
-- about this work" becomes a RECORD on the work's own spine.
--
-- WHY. The owner-escalation ladder's verify step asks "has a person already been told about
-- THIS row?" and the platform had nowhere to read an answer from: `deliveries` carries only
-- `root_kind`/`root_id`, no work reference. The pm-cluster ruling (2026-10-07) refused both
-- shortcuts — matching a delivery to the row by TURN COINCIDENCE (an unrelated sentence on the
-- turn that read the steer would retire the escalation) and by CONTENT INSPECTION — and left
-- the ladder fail-safe: the owner told twice rather than never. The record is written only by
-- a path that structurally holds the work id (a send whose tool arguments name the work, or
-- the owner-notice door that carries it), keyed by the delivery that path wrote:
-- `work/validation-drive.ts:recordPersonTold`. OR-TRACKER-1: the record lives in the tracker,
-- not in a new table.
--
-- THE LIST ONLY GROWS HERE, so there is no quarantine step: every row that satisfied 159's
-- CHECK satisfies this one. `work/event-kinds.ts` carries the same 27 values and
-- `work/__tests__/work-event-kinds-conformance.test.ts` asserts the two are set-equal in both
-- directions, so neither can move alone.
--
-- THE REBUILD is 159's, verbatim in shape, for its reasons (SQLite has no ADD CONSTRAINT), with
-- ONE difference re-derived against the schema at this head: migration 178 gave `work_events`
-- its first index since 159, and a rebuild drops it with the old table — so it is re-created
-- below, by the same name and columns, or every work-scoped event read on a grown box goes back
-- to a full scan. No triggers, views or inbound `REFERENCES` name `work_events` (re-verified).
-- `id` is copied EXPLICITLY (the poke ladder, the override queue, `validatedExpr` and
-- `adjudications.event_seq` all order by it) and the AUTOINCREMENT counter is carried by hand:
-- a rebuild silently resets it, and AUTOINCREMENT's contract is that an id is never reused.

CREATE TABLE work_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
    'compile_resolved','floor_ghosted','join_complete','join_opened','occurrence_fired',
    'occurrence_released','occurrence_settled','opened','override_request','override_resolved',
    'owed_interrupt','person_told','poke','poke_remediation','rearm_refused','revert_reset',
    'transition','user_verdict_cleared','user_verdict_requested','validation_escalated',
    'validation_requested'
  )),
  payload TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO work_events_new (id, work_id, kind, payload, actor, created_at)
SELECT id, work_id, kind, payload, actor, created_at FROM work_events;

INSERT INTO sqlite_sequence (name, seq)
SELECT 'work_events_new', 0
 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'work_events_new');

UPDATE sqlite_sequence
   SET seq = (SELECT MAX(COALESCE(seq, 0)) FROM sqlite_sequence WHERE name IN ('work_events', 'work_events_new'))
 WHERE name = 'work_events_new';

DROP TABLE work_events;
ALTER TABLE work_events_new RENAME TO work_events;

CREATE INDEX IF NOT EXISTS idx_work_events_work_id ON work_events(work_id, kind, created_at);
