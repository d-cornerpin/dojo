-- ════════════════════════════════════════════════════════════════════════════════════════
-- PHASE-2 T8a — the tracker's ATTRIBUTE columns move onto the work spine.
--
-- WHY THIS FILE EXISTS. T2 (`135_work_spine.sql`) moved the tracker's *identity and state*
-- onto `work` and deliberately carried only the intersecting subset of columns. T8's Step 1
-- then found the gap: `transition()` is the one writer of `work.state`, so moving the
-- tracker's WRITES onto it necessarily moves the tracker's READS onto `work` in the same
-- change — and `work` did not carry the columns those reads name. The task returned BLOCKED
-- rather than improvising, and the orchestrator ruled (PHASE-2 ledger, 2026-07-29):
--
--   "Fork A, SCOPED BY READERS: migration 137 moves onto `work` exactly the attribute
--    columns with LIVE PRODUCTION READERS, enumerated by command, each declared in the
--    spine manifest with its reader named; the two-key trigger renumbers to 138; columns
--    WITHOUT live readers are listed with their enumeration evidence and die with
--    `legacy_tasks` at T10. Not all 60; readers are the criterion."
--
-- Fork B (state on `work`, attributes on the legacy row until T10) was REFUSED: two tables
-- authoritative for one noun is the two-mechanism disease itself.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- THE ENUMERATION, AND WHAT IT COST
--
-- Method (recorded so it can be re-run rather than believed): every PRODUCTION source file
-- that names `legacy_tasks` or `legacy_projects` (22 files, `git grep -lE
-- "legacy_tasks|legacy_projects" -- packages watchdog | grep -v "__tests__|.test.ts|/migrations/"`)
-- was parsed with comments blanked FIRST, every SELECT statement whose FROM/JOIN names a
-- legacy table extracted (149 statements), and each column indexed against them. `SELECT *`
-- sites (13) were resolved on the consumer side — `tracker/schema.ts`'s `mapTaskRow` /
-- `mapProjectRow`, which are what the dashboard's board renders.
--
-- `legacy_tasks` has 62 columns and `legacy_projects` 17; thirteen names are shared, so the
-- DISTINCT surface is 66 (`SELECT count(*) FROM pragma_table_info(...)` on both, unioned).
-- Of those 66:
--   * 15 are ALREADY expressed on `work` under the spine's own names and only the READS
--     rekey (no DDL): id, title, notes, goal, priority, next_run_at, updated_at,
--     status->state, assigned_to->agent_id/assignee_agent, project_id->parent_id,
--     created_by->requester_id, created_at->opened_at, completed_at->closed_at,
--     anchor_time->anchor_local, run_count->attempts.
--   * 8 DIE IN THIS TASK to migration 138's two-key trigger: pause_validated,
--     complete_validated, blocked_validated, revert_count, awaiting_user_verdict,
--     user_verdict_requested_at, validation_escalated_at, validation_thread_id. They become
--     `adjudications` rows; revert count becomes COUNT(verdict='rejected').
--   * 4 have NO PRODUCTION READER and are NOT moved (they die with `legacy_tasks` at T10;
--     the enumeration evidence is in the T8a report, and a row count was never the
--     evidence — roadmap #15): `last_answer_message_id`, `last_delivery_at`,
--     `legacy_tasks.created_by_kind`, `legacy_projects.created_by_kind`.
--   * the remaining 40 are below, each with the reader that keeps it alive.
--     (15 + 8 + 3 + 40 = 66, and that arithmetic is the point: nothing was left unclassified.)
--
-- `work` therefore goes 37 -> 77 columns, and that number is stated rather than hidden. Two
-- of the families below are BRIDGES with a named collapse already scheduled, and the DDL
-- says so beside them rather than in a document that can go stale:
--   * the six STAMP columns are research 19 s1c's "view over work_events + deliveries";
--     T8b (the PM rekey) is where that view replaces them.
--   * the thirteen SCHEDULE columns re-express as `schedule_json`/`tz`/`anchor_local`/
--     `sequence` + occurrence rows, which T2 already put on this table for the purpose;
--     T8c (scheduler occurrences) is where that collapse happens.
-- Neither family is blessed by being moved. A column that arrives here with a named
-- successor and a named task is a bridge; one that arrives with neither is the accretion
-- research 03 diagnosed, and there are none of those in this file.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- TIME COLUMNS ARE CONVERTED, NOT COPIED
--
-- The legacy tables store instants as SQLite-form TEXT (`datetime('now')`); `work` stores
-- them as INTEGER epoch-ms with a sanity CHECK. `deploy/checks/check-iso-writes.mjs`
-- documents exactly what happens when the two forms meet in one column that something
-- ORDER BYs. Every instant below therefore lands as INTEGER ms using the same
-- `CAST(strftime('%s', x) AS INTEGER) * 1000` idiom migration 135 used, and the READS
-- convert when they rekey. `anchor_time` is NOT here: it is wall-clock INTENT, it is
-- already on `work` as `anchor_local` TEXT, and that is the naming law working.
--
-- ids are shared by construction (T2 preserved them: `work.id` IS the task/project id), so
-- every backfill below is a straight correlated UPDATE keyed on id.
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── PART 1 — CONTENT ────────────────────────────────────────────────────────────────────
-- reader: tracker/schema.ts:121 `mapTaskRow` -> Task.description -> the dashboard board;
--         tracker/schema.ts:86 `mapProjectRow` -> Project.description; scheduler/runner.ts:1058
ALTER TABLE work ADD COLUMN description TEXT;
-- reader: tracker/tools.ts:2098 — the immutable copy of the owner's original ask, compared
--         byte-for-byte against `description` to tell an EDIT from a RESTATEMENT
ALTER TABLE work ADD COLUMN original_description TEXT;
-- reader: agent/spawner.ts:675 (the apprentice-result predicate), :724 (the evidence pointer)
ALTER TABLE work ADD COLUMN completion_summary TEXT;
-- reader: tracker/schema.ts:155 `mapTaskRow` -> Task.result
ALTER TABLE work ADD COLUMN result TEXT;
-- reader: tracker/schema.ts:156 `mapTaskRow` -> Task.evidence (parsed JSON array)
ALTER TABLE work ADD COLUMN evidence_json TEXT;

-- ── PART 2 — SHAPE: step / phase / dependency ───────────────────────────────────────────
-- reader: tracker/schema.ts:127; ORDER BY step_number at tracker/schema.ts:317
ALTER TABLE work ADD COLUMN step_number INTEGER;
-- reader: tracker/schema.ts:128
ALTER TABLE work ADD COLUMN total_steps INTEGER;
-- reader: tracker/schema.ts:129 (task phase); distinct from the project's `current_phase`
ALTER TABLE work ADD COLUMN phase INTEGER;
-- reader: tracker/schema.ts:112+130 (JSON array parsed into Task.dependsOn);
--         tracker/pm-agent.ts:1868 (`depends_on LIKE ?` — the dependency unblock sweep).
-- NOTE for T8b/T9: `work/store.ts:29` records the dependency cascade as an effect
-- `transition()` still owes. This column is what it will read until dependencies become
-- parent/child rows; it is a bridge with a named owner, not a resting place.
ALTER TABLE work ADD COLUMN depends_on TEXT;
-- reader: tracker/schema.ts:145; agent/tools.ts:7754 (group reassignment)
ALTER TABLE work ADD COLUMN assigned_to_group TEXT;
-- reader: scheduler/runner.ts:1110 (`row.kind === 'reminder'` — the reminder discriminator),
--         agent/v2/loop.ts:1486. NAMED `task_kind` DELIBERATELY: `work.kind` is the spine's
--         own five-value noun enum and this is a different fact. Two facts, two columns.
ALTER TABLE work ADD COLUMN task_kind TEXT;

-- ── PART 3 — PROJECT-SIDE SHAPE ─────────────────────────────────────────────────────────
-- reader: tracker/schema.ts:88 `mapProjectRow` -> Project.level
ALTER TABLE work ADD COLUMN level INTEGER;
-- reader: tracker/schema.ts:90 -> Project.phaseCount
ALTER TABLE work ADD COLUMN phase_count INTEGER;
-- reader: tracker/schema.ts:91 -> Project.currentPhase; written at tracker/schema.ts:479
ALTER TABLE work ADD COLUMN current_phase INTEGER;
-- reader: agent/tools.ts:581, :596 (group-scoped project listing)
ALTER TABLE work ADD COLUMN group_id TEXT;

-- ── PART 4 — LINEAGE ────────────────────────────────────────────────────────────────────
-- `work.root_kind`/`root_id` carry origin for rows OPENED on the spine; 135's backfill set
-- them to ('legacy', <id>) for migrated rows, so the three lineage facts below are NOT
-- expressed by them for the tracker's population and each has its own readers.
-- reader: tracker/tools.ts:570; tracker/delivery-evidence.ts:51,:165; agent/v2/loop.ts:5514
ALTER TABLE work ADD COLUMN source_message_id TEXT;
-- reader: tracker/task-stamps.ts:91; tracker/tools.ts:206; agent/v2/loop.ts:9425
ALTER TABLE work ADD COLUMN origin_turn INTEGER;
-- reader: agent/v2/loop.ts:1486; tracker/delivery-evidence.ts:51,:165; tracker/task-stamps.ts:91.
-- FLAGGED IN THE OPEN: this is the ONE column here whose NAME is the mechanism this phase is
-- deleting. It is moved because the ruling's criterion is readers and it has four live ones;
-- it is NOT blessed. T10 owns `conv_key`'s demolition and this column is expected to be the
-- first thing dropped after it. The T3 conv-key inventory gate counts the PREDICATE
-- (`conv_key IS NULL`), not this column, so nothing about this move relaxes that burn-down.
ALTER TABLE work ADD COLUMN origin_conv_key TEXT;
-- reader: agent/v2/loop.ts:347 (`p.origin_kind = 'engine_scaffold'`); tracker/tools.ts:570
--         (the same predicate on the project side); tracker/delivery-evidence.ts:165.
--         Live values on this box: engine_scaffold 45 / model 5.
-- SUCCESSOR NAMED, AND IT IS NOT MINE TO SWITCH: PHASE-2 T8b Step 4 rekeys these three
-- readers onto `work.root_kind='engine_scaffold'` (`root_kind` already exists; 135 backfilled
-- it to 'legacy' for every migrated row, so the fact is NOT expressed there today). This
-- column is moved so those readers survive the read-move, and it is T8b's to retire. Doing
-- the root_kind rewrite here would have been reaching into T8b's step from T8a.
ALTER TABLE work ADD COLUMN origin_kind TEXT;
-- reader: tracker/tools.ts:2957 — the RETASK BACKSTOP, which refuses to regenerate work the
--         owner was already shown unless `allow_regenerate` is passed. That guard has an
--         incident behind it (PINNED s12) and it is the reason this column is NOT on the
--         no-reader list. tracker/pm-agent.ts:431 is the PM's read, which T8b strips.
--         MOVING IT STRIPS NOTHING: T8a does not touch either guard branch.
ALTER TABLE work ADD COLUMN deliverable_shown INTEGER NOT NULL DEFAULT 0;
-- reader: tracker/schema.ts:648; tracker/tools.ts:309,:1833; tracker/pm-agent.ts:1464
ALTER TABLE work ADD COLUMN a2a_thread_id TEXT;
-- reader: gateway/routes/tracker.ts:350 (the elevated-tasks route), rendered by the
--         dashboard at pages/Tracker.tsx:775
ALTER TABLE work ADD COLUMN last_smell_flag TEXT;

-- ── PART 5 — THE SCHEDULE AXIS (bridge; collapses at T8c) ───────────────────────────────
-- `work` already carries `schedule_json`, `tz`, `anchor_local`, `next_run_at` and `sequence`
-- — T2 put them there as the intended expression. These thirteen are the legacy shape the
-- scheduler still reads TODAY; T8c turns occurrences into rows and this family goes with it.
-- reader: tracker/schema.ts:132; scheduler/runner.ts:1058
ALTER TABLE work ADD COLUMN scheduled_start INTEGER;
-- reader: tracker/schema.ts:133; scheduler/engine.ts recurrence maths
ALTER TABLE work ADD COLUMN repeat_interval INTEGER;
-- reader: tracker/schema.ts:134
ALTER TABLE work ADD COLUMN repeat_unit TEXT;
-- reader: tracker/schema.ts:135
ALTER TABLE work ADD COLUMN repeat_end_type TEXT;
-- reader: tracker/schema.ts:136
ALTER TABLE work ADD COLUMN repeat_end_value TEXT;
-- reader: tracker/schema.ts:137 — the "weekdays never yields Sat/Sun" list (T8c's new scenario)
ALTER TABLE work ADD COLUMN repeat_days_of_week TEXT;
-- reader: tracker/schema.ts:144; scheduler/runner.ts:584 (`schedule_status = 'waiting'`), :1106
ALTER TABLE work ADD COLUMN schedule_status TEXT;
-- reader: tracker/schema.ts:141; scheduler/runner.ts:468, :584. A SEPARATE AXIS from
--         `state='paused'` — T6's reopen edge negative-controls the two against each other.
ALTER TABLE work ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
-- reader: tracker/schema.ts:142; scheduler/runner.ts:1550
ALTER TABLE work ADD COLUMN paused_until INTEGER;
-- reader: tracker/schema.ts:143; agent/v2/answered-edge.ts (T6's reopen restores EXACTLY the
--         state the engine parked the row from — the engine's own record that IT paused it)
ALTER TABLE work ADD COLUMN status_before_pause TEXT;
-- reader: scheduler/runner.ts (last-fire clock for the missed-run policy)
ALTER TABLE work ADD COLUMN last_run_at INTEGER;
-- reader: scheduler/runner.ts:468-471 (the auto-resolve fallback), :341-352 (the sweep
--         exclusion that distinguishes an ENGINE pause from an agent's own)
ALTER TABLE work ADD COLUMN missed_runs_paused_at INTEGER;

-- ── PART 6 — THE ACTIVITY STAMPS (bridge; become a view at T8b) ─────────────────────────
-- research 19 s1c: "the last_activity_* / last_answered_* / last_delivery_* stamp columns
-- become a view over work_events + deliveries — one writer, many readers." T8b owns that.
-- Until then these have five live readers each and the tracker cannot render without them.
-- reader: tracker/task-stamps.ts:180; tracker/tools.ts:62; tracker/pm-agent.ts:1824;
--         memory/assembler.ts:925; agent/v2/loop.ts:2251
ALTER TABLE work ADD COLUMN last_activity_turn INTEGER;
ALTER TABLE work ADD COLUMN last_activity_at INTEGER;
ALTER TABLE work ADD COLUMN last_activity_outcome TEXT;
-- reader: tracker/task-stamps.ts:169-178; tracker/tools.ts:2376, :2512; same four callers
ALTER TABLE work ADD COLUMN last_answered_turn INTEGER;
ALTER TABLE work ADD COLUMN last_answered_at INTEGER;
-- reader: tracker/task-stamps.ts:175-176; tracker/tools.ts:2376, :2381, :2512
ALTER TABLE work ADD COLUMN last_delivery_summary TEXT;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- BACKFILL. One correlated UPDATE per source table, keyed on the shared id. A `work` row
-- with no legacy twin (every ask, commitment, occurrence and join opened since T3) keeps
-- the column NULL, which is the truth about it.
-- ════════════════════════════════════════════════════════════════════════════════════════

UPDATE work SET
  description           = (SELECT t.description           FROM legacy_tasks t WHERE t.id = work.id),
  original_description  = (SELECT t.original_description  FROM legacy_tasks t WHERE t.id = work.id),
  completion_summary    = (SELECT t.completion_summary    FROM legacy_tasks t WHERE t.id = work.id),
  result                = (SELECT t.result                FROM legacy_tasks t WHERE t.id = work.id),
  evidence_json         = (SELECT t.evidence_json         FROM legacy_tasks t WHERE t.id = work.id),
  step_number           = (SELECT t.step_number           FROM legacy_tasks t WHERE t.id = work.id),
  total_steps           = (SELECT t.total_steps           FROM legacy_tasks t WHERE t.id = work.id),
  phase                 = (SELECT t.phase                 FROM legacy_tasks t WHERE t.id = work.id),
  depends_on            = (SELECT t.depends_on            FROM legacy_tasks t WHERE t.id = work.id),
  assigned_to_group     = (SELECT t.assigned_to_group     FROM legacy_tasks t WHERE t.id = work.id),
  task_kind             = (SELECT t.kind                  FROM legacy_tasks t WHERE t.id = work.id),
  source_message_id     = (SELECT t.source_message_id     FROM legacy_tasks t WHERE t.id = work.id),
  origin_turn           = (SELECT t.origin_turn           FROM legacy_tasks t WHERE t.id = work.id),
  origin_conv_key       = (SELECT t.origin_conv_key       FROM legacy_tasks t WHERE t.id = work.id),
  origin_kind           = (SELECT t.origin_kind           FROM legacy_tasks t WHERE t.id = work.id),
  deliverable_shown     = (SELECT COALESCE(t.deliverable_shown, 0) FROM legacy_tasks t WHERE t.id = work.id),
  a2a_thread_id         = (SELECT t.a2a_thread_id         FROM legacy_tasks t WHERE t.id = work.id),
  last_smell_flag       = (SELECT t.last_smell_flag       FROM legacy_tasks t WHERE t.id = work.id),
  scheduled_start       = (SELECT CAST(strftime('%s', t.scheduled_start) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  repeat_interval       = (SELECT t.repeat_interval       FROM legacy_tasks t WHERE t.id = work.id),
  repeat_unit           = (SELECT t.repeat_unit           FROM legacy_tasks t WHERE t.id = work.id),
  repeat_end_type       = (SELECT t.repeat_end_type       FROM legacy_tasks t WHERE t.id = work.id),
  repeat_end_value      = (SELECT t.repeat_end_value      FROM legacy_tasks t WHERE t.id = work.id),
  repeat_days_of_week   = (SELECT t.repeat_days_of_week   FROM legacy_tasks t WHERE t.id = work.id),
  schedule_status       = (SELECT t.schedule_status       FROM legacy_tasks t WHERE t.id = work.id),
  is_paused             = (SELECT COALESCE(t.is_paused, 0) FROM legacy_tasks t WHERE t.id = work.id),
  paused_until          = (SELECT CAST(strftime('%s', t.paused_until) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  status_before_pause   = (SELECT t.status_before_pause   FROM legacy_tasks t WHERE t.id = work.id),
  last_run_at           = (SELECT CAST(strftime('%s', t.last_run_at) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  missed_runs_paused_at = (SELECT CAST(strftime('%s', t.missed_runs_paused_at) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  last_activity_turn    = (SELECT t.last_activity_turn    FROM legacy_tasks t WHERE t.id = work.id),
  last_activity_at      = (SELECT CAST(strftime('%s', t.last_activity_at) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  last_activity_outcome = (SELECT t.last_activity_outcome FROM legacy_tasks t WHERE t.id = work.id),
  last_answered_turn    = (SELECT t.last_answered_turn    FROM legacy_tasks t WHERE t.id = work.id),
  last_answered_at      = (SELECT CAST(strftime('%s', t.last_answered_at) AS INTEGER) * 1000 FROM legacy_tasks t WHERE t.id = work.id),
  last_delivery_summary = (SELECT t.last_delivery_summary FROM legacy_tasks t WHERE t.id = work.id)
WHERE EXISTS (SELECT 1 FROM legacy_tasks t WHERE t.id = work.id);

UPDATE work SET
  description       = (SELECT p.description   FROM legacy_projects p WHERE p.id = work.id),
  level             = (SELECT p.level         FROM legacy_projects p WHERE p.id = work.id),
  phase_count       = (SELECT p.phase_count   FROM legacy_projects p WHERE p.id = work.id),
  current_phase     = (SELECT p.current_phase FROM legacy_projects p WHERE p.id = work.id),
  group_id          = (SELECT p.group_id      FROM legacy_projects p WHERE p.id = work.id),
  source_message_id = (SELECT p.source_message_id FROM legacy_projects p WHERE p.id = work.id),
  origin_turn       = (SELECT p.origin_turn   FROM legacy_projects p WHERE p.id = work.id),
  origin_conv_key   = (SELECT p.origin_conv_key FROM legacy_projects p WHERE p.id = work.id),
  origin_kind       = (SELECT p.origin_kind     FROM legacy_projects p WHERE p.id = work.id)
WHERE EXISTS (SELECT 1 FROM legacy_projects p WHERE p.id = work.id);

-- 135 folded a PROJECT's description into `work.notes` because `work` had no `description`
-- column to put it in. It has one now, and the project UPDATE above has just filled it from
-- the source. Leaving the duplicate in `notes` would be two columns carrying one fact — the
-- thing this phase exists to stop — so the copy is cleared where it is provably a copy.
UPDATE work SET notes = NULL
WHERE kind = 'project' AND notes IS NOT NULL AND notes IS description;

-- The board's read (`kind IN ('task','project')` filtered by state) now also sorts on
-- step_number for a project's children, which is `mapTaskRow`'s ORDER BY at
-- tracker/schema.ts:317. One index, matching that query's shape.
CREATE INDEX ix_work_children_order ON work(parent_id, step_number)
  WHERE kind = 'task';

-- The scheduler's due-scan (scheduler/runner.ts:584) is `next_run_at <= ? AND
-- schedule_status = 'waiting' AND is_paused = 0`. `legacy_tasks` had no index for it either;
-- `work` is about to carry every row the scheduler walks, so it gets one.
CREATE INDEX ix_work_due ON work(schedule_status, is_paused, next_run_at)
  WHERE schedule_status IS NOT NULL;
