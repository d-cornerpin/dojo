-- 152 (PHASE-4 T4-SCHEMA): `work_events.kind` GETS THE CHECK IT HAS ALWAYS BEEN SAID TO HAVE.
--
-- WHAT WAS BROKEN. Migration `135_work_spine.sql:75` reads:
--
--     kind TEXT NOT NULL,   -- 12-value enum per 19 s1c incl. 'poke','override_request','observation'
--
-- and that comment was the whole enum. No CHECK on the column. No TypeScript union either —
-- `work/store.ts appendEvent(workId, kind: string, …)`. The tree-wide grep for a CHECK on
-- this table returns exactly one hit and it is another COMMENT, in `144:343`, saying there
-- is none. So there were three statements of "which kinds exist" and nothing that could
-- notice they disagreed: TWELVE in the comment, TWENTY-FOUR writable from production code
-- over 29 call sites, SIXTEEN actually stored (4,953 rows, dev body, 2026-08-02). The
-- comment is a faithful transcription of a DESIGN DOCUMENT's enum (research
-- `19-rebuild-map-lifts.md:33` §1c) into a schema file; nothing ever made it true.
--
-- THE LIST BELOW IS DERIVED, and the command is beside the number (roadmap #14):
--   git grep -ohE "append(Work)?Event\([^,]+, *'[a-z_]+'" HEAD -- packages/server/src \
--     | grep -v __tests__ | sed -E "s/.*'([a-z_]+)'/\1/" | sort -u          -> 11 literals
--   + five constant objects, the only other route (AUDIT_KIND, OCCURRENCE_EVENT,
--     OVERRIDE_EVENT, POKE_EVENT/REMEDIATION_EVENT, WORK_EVENT)               -> 13 more
--   = 24, + `floor_ghosted` = 25. `work/event-kinds.ts` holds the same 25 as a TypeScript
--   union; `work/__tests__/work-event-kinds-conformance.test.ts` asserts this file's list
--   and that one are set-equal in both directions, so neither can move alone.
--
-- ═══ THIS IS THE DANGEROUS MIGRATION CLASS, AND IT IS THE `.23` INCIDENT'S CLASS ═══
--
-- A CHECK constraint born on a column with live rows VALIDATES EVERY EXISTING ROW at the
-- moment it is created. One stray value on somebody's lived-in database and the INSERT ..
-- SELECT throws, the file's transaction rolls back, the chain halts at `151` forever and the
-- update fails — on a box we cannot see and cannot inspect. `151`, the migration immediately
-- before this one, is the OPPOSITE shape and says so in its own header: a BEFORE DELETE
-- trigger validates nothing at creation, so it cannot abort a lived-in chain. This file has
-- no such luxury, which is why the question "what happens to a pre-existing off-list row?"
-- is answered HERE, in writing, before the rebuild runs.
--
-- ── THE ANSWER IS DERIVED FROM WHAT SUCH A ROW COULD BE, NOT INVENTED ──
-- Three enumerations, all by command, before this policy was written:
--   1. CODE, ACROSS ALL OF HISTORY. `work_events` was born at `135` (commit 6f17259). Every
--      one of the 178 commits from there to HEAD was re-enumerated with the two commands
--      above. The writable set has NEVER differed from the 24 — not one kind was ever added
--      and later removed. So no version of this platform can have written an off-list row.
--   2. THE CHAIN ITSELF. Three migration files INSERT into this table directly (`135b`,
--      `144`, `146`); between them they write `poke`, `override_request`,
--      `occurrence_settled` and `audit`. All four are on the list, so a stable box replaying
--      135b → 146 → 152 cannot be aborted by its own chain.
--   3. THE WORN-IN BODY. 0 off-list rows out of 4,953, over 16 distinct kinds.
--
-- Therefore an off-list row on a real database is not a product of this platform: it is a
-- hand edit, a foreign tool, or a build from a future nobody here can see. It is real data
-- all the same, and the one thing this file may not do is destroy it or refuse to run.
--
-- SO: CARRY, NEVER ABORT — and carry it into the shape this chain already uses for exactly
-- this. `146` absorbed the whole of `task_log` into `kind='audit'` with the entry's own kind
-- inside the payload as `entry_kind`, for a reason `work/audit-trail.ts`'s header states:
-- trail entry kinds COLLIDE BY NAME with spine event kinds, and `kind='audit'` is read in
-- one module and nowhere else — so nothing filed there can answer a predicate that decides
-- whether work counts as validated, escalated or poked. That makes it the only safe landing
-- place in the schema for a value nobody can vouch for. The original `kind` and the original
-- `payload` bytes both survive, verbatim, inside the new payload; the row keeps its `id`
-- (which the poke ladder orders by), its `actor` and its `created_at`. Nothing is deleted
-- and nothing is forged: this file does not manufacture a receipt, an outcome or a
-- transition — the forged-completion class migration `108` was demolished for. It relabels a
-- record whose category the spine does not own, and says so in the record.
--
-- On any honest body the branch takes zero rows. It is a safety net, not a data transform,
-- and it is proven to FIRE (adversarial rehearsal, below) rather than assumed to.
--
-- ── WHY A CHECK AND NOT A SECOND TRIGGER ──
-- The requirement is that the DECLARED list becomes REAL. A CHECK is a property of the
-- column, readable out of `sqlite_master` by any tool including the conformance test that
-- diffs it against the TypeScript union; a trigger states the same list in imperative code
-- that nothing can diff. `151` chose a trigger because a trigger cannot be switched off by
-- `PRAGMA foreign_keys`; that argument does not apply to a CHECK, which no pragma disables
-- either. The cost of the CHECK is the rebuild and the abort risk, and the quarantine above
-- is what pays it.
--
-- ── THE REBUILD, and what it must not disturb ──
-- SQLite has no ADD CONSTRAINT, so the column gets its CHECK the only way it can: the
-- standard create/copy/drop/rename, the same shape the chain already runs at `019`. Verified
-- by command before writing this, because each is a way to lose something:
--   * INDEXES on `work_events`:  none, in the live schema or anywhere in the chain.
--   * TRIGGERS on `work_events`: none.
--   * VIEWS naming it:           none.
--   * `REFERENCES work_events`:  none — grep over the whole migrations directory.
-- So there is nothing to re-create afterwards, and the rename cannot orphan a reference.
-- `id` is copied EXPLICITLY: `work/poke-ladder.ts` bounds the poke cycle on `work_events.id`
-- precisely because a remediation and the next poke can share a millisecond, so renumbering
-- would silently break the ladder. `AUTOINCREMENT` is preserved and `sqlite_sequence` follows
-- the rename, asserted in the rehearsal and in the permanent guard.
-- FK enforcement is OFF for the whole chain (`db/migrations.ts` sets it outside the loop), and
-- each file is applied inside ONE transaction with its `_migrations` row, so a failure here
-- leaves the database exactly as it was.

-- ── STEP 1 — quarantine, before anything can refuse ────────────────────────────────────
-- Runs first so the rebuild below CANNOT abort. `kind` on the right-hand side is the OLD
-- value: SQLite evaluates every SET expression against the original row.
UPDATE work_events
   SET payload = json_object(
         'entry_kind',       kind,
         'from_status',      NULL,
         'to_status',        NULL,
         'reason',           'kind was not on the declared list when migration 152 created the CHECK',
         'action_taken',     'carried into the audit trail; original kind and payload preserved below',
         'note',             NULL,
         'evidence_json',    NULL,
         'provenance',       'quarantined_by_152',
         'original_kind',    kind,
         'original_payload', payload),
       kind = 'audit'
 WHERE kind NOT IN (
   'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
   'compile_resolved','floor_ghosted','join_complete','join_opened','occurrence_fired',
   'occurrence_released','occurrence_settled','opened','override_request','override_resolved',
   'poke','poke_remediation','rearm_refused','revert_reset','transition',
   'user_verdict_cleared','user_verdict_requested','validation_escalated','validation_requested'
 );

-- ── STEP 2 — the CHECK, born on the live column ────────────────────────────────────────
CREATE TABLE work_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
    'compile_resolved','floor_ghosted','join_complete','join_opened','occurrence_fired',
    'occurrence_released','occurrence_settled','opened','override_request','override_resolved',
    'poke','poke_remediation','rearm_refused','revert_reset','transition',
    'user_verdict_cleared','user_verdict_requested','validation_escalated','validation_requested'
  )),
  payload TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO work_events_new (id, work_id, kind, payload, actor, created_at)
SELECT id, work_id, kind, payload, actor, created_at FROM work_events;

-- THE AUTOINCREMENT COUNTER, carried by hand — a rebuild silently resets it otherwise, and
-- a silently-weakened declared property is the disease this whole task is about. Copying the
-- rows sets the new table's counter to MAX(id); the OLD counter is higher whenever rows have
-- ever been deleted (the dev body: max(id) 6777, counter 6783 — six ids that belonged to rows
-- the harness teardown removed), and AUTOINCREMENT's contract is that those six are never
-- handed out again. Runs after the copy (so the new row exists in `sqlite_sequence`) and
-- before the DROP (so the old one still does); on a body with no rows, neither row exists and
-- this matches nothing, which is correct.
UPDATE sqlite_sequence
   SET seq = (SELECT MAX(seq) FROM sqlite_sequence WHERE name IN ('work_events', 'work_events_new'))
 WHERE name = 'work_events_new';

DROP TABLE work_events;
ALTER TABLE work_events_new RENAME TO work_events;
