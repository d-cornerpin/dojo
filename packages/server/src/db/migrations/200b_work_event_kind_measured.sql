-- 200b (v3.5, DONE IS MEASURED): `measured` JOINS THE DECLARED work_events KINDS — each reading
-- of a task's measure (migration 200) is a RECORD on the task's own spine: what the measure
-- returned, when, and whether it could be read at all, so the PM and the owner see the trend and
-- an outage is on the record rather than a guess.
--
-- THE LIST ONLY GROWS HERE, so there is no quarantine step: every row that satisfied 189's CHECK
-- satisfies this one. `work/event-kinds.ts` carries the same 28 values and
-- `work/__tests__/work-event-kinds-conformance.test.ts` asserts the two are set-equal in both
-- directions, so neither can move alone.
--
-- THE REBUILD is 189's, verbatim in shape, for its reasons (SQLite has no ADD CONSTRAINT).
-- Re-derived against the schema at this head: no migration since 189 added an index, trigger,
-- view or inbound REFERENCES on `work_events`; the one index (178's) is re-created below by the
-- same name and columns. 189c's `adjudications_event_seq` trigger names only `sqlite_sequence`,
-- so the RENAME re-validates it cleanly. `id` is copied EXPLICITLY and the AUTOINCREMENT counter
-- is carried by hand: a rebuild silently resets it, and an id is never reused.

CREATE TABLE work_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
    'compile_resolved','floor_ghosted','join_complete','join_opened','measured','occurrence_fired',
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
