-- 135_work_spine.sql — PHASE-2 T2: the order-ticket IS the tracker (OR1).
--
-- One table, one ID space. `tasks` and `projects` STOP being two entities and become two
-- `kind`s of one row, with their ids carried over unchanged. `done` stops being a word the
-- model may write and becomes a state that REQUIRES a delivery to point at. The two legacy
-- tables are renamed, not dropped, in this same file: a reader nobody re-pointed fails loud
-- instead of quietly reading a stale twin. T10 drops them.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 0 — THE THREE T0 RIDERS ON THIS DDL (PHASE-2.md, DECIDED 2026-07-28), each carried
-- here with the decision that produced it, because a rider that lives only in a plan file
-- is a rider that the next schema edit deletes by accident.
--
--  1. `work.agent_id` TAKES NO FOREIGN KEY AND NO `ON DELETE CASCADE`, DELIBERATELY.
--     A terminated agent's work rows must OUTLIVE their agent (owner ruling 2026-07-28:
--     terminated agents' records are an asset, and a searchable archive of their work is
--     owed — placed in SWEEP-G by T0's D1). The failure mode is not hypothetical:
--     `audit_log` DECLARES `REFERENCES agents(id) ON DELETE CASCADE` and its 182 orphaned
--     rows (38 deleted agents, measured 2026-07-28) survive only because FK enforcement
--     happens to be off for that table. This spine does not rely on that accident: the FK
--     is omitted on purpose. Do not "fix" it by adding one.
--
--  2. A GENERATION/VIDEO JOB IS NOT A WORK ROW (T0 D3, typed side-queues).
--     When an agent starts one on someone's behalf, the OBLIGATION is a `work` row and the
--     JOB stays in its own queue referencing it — both queues already carry `task_id` and
--     `conversation_id`, so the link exists. NO `provider_job_id`, `asset_path`,
--     `attempt_count`-style media columns belong on `work`; adding them is how `tasks`
--     reached 60 columns, which is the disease this file exists to end.
--
--  3. `provenance` KEEPS ALL THREE VALUES. `'live'` and `'migrated'` are both already in
--     use on a live body (messages: live 3,304 / migrated 2,889); `'rescued'` is the value
--     T10 needs when `agent_messages`' rows are lifted before that table drops.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE `work` TABLE

CREATE TABLE work (
  id TEXT PRIMARY KEY,                    -- task ids carry over: one ID space (OR1)
  kind TEXT NOT NULL CHECK (kind IN ('ask','task','project','occurrence','commitment')),
  parent_id TEXT REFERENCES work(id),
  -- NO FK, NO CASCADE on agent_id — see PART 0 rider 1. This is the whole rider.
  agent_id TEXT NOT NULL, assignee_agent TEXT,
  requester TEXT NOT NULL CHECK (requester IN ('owner','agent','schedule','watcher')),
  requester_id TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  root_kind TEXT NOT NULL, root_id TEXT NOT NULL,   -- origin REQUIRED (may be 'legacy')
  state TEXT NOT NULL CHECK (state IN ('open','claimed','done','failed','abandoned','paused','blocked','on_deck')),
  claimed_by_turn INTEGER,
  result_delivery_id TEXT REFERENCES deliveries(id),
  intent TEXT NOT NULL,                   -- no default: the writer must say. The old
                                          -- `FYI` default silently killed wake-needing work.
  wakes INTEGER NOT NULL, closes_thread INTEGER NOT NULL,  -- INDEPENDENT columns: conflating
                                          -- them stalled multi-step workflows (v2.5.32)
  hop_count INTEGER NOT NULL DEFAULT 0, superseded_by TEXT,
  title TEXT, goal TEXT, priority TEXT, notes TEXT,
  remaining_children INTEGER,             -- fan-out countdown (atomic decrement)
  compile_pending INTEGER NOT NULL DEFAULT 0,  -- distinct state: pieces landed <> owner answered
  ttl_at INTEGER, reply_conversation_id TEXT,   -- COPIED at park time, never resolved later
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  schedule_json TEXT, tz TEXT, anchor_local TEXT, next_run_at INTEGER, sequence INTEGER,
  opened_at INTEGER NOT NULL CHECK (opened_at > 1600000000000),
  closed_at INTEGER, updated_at INTEGER NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','migrated','rescued')),
  CHECK ((state IN ('done','failed','abandoned')) = (closed_at IS NOT NULL)),
  CHECK (state <> 'done' OR result_delivery_id IS NOT NULL),   -- done means DELIVERED
  CHECK (kind <> 'project' OR parent_id IS NULL)
);
CREATE INDEX ix_work_queue ON work(agent_id, state, kind);
CREATE INDEX ix_work_root ON work(root_kind, root_id);
CREATE UNIQUE INDEX ux_work_occurrence ON work(parent_id, sequence)
  WHERE kind='occurrence';                 -- one occurrence, one execution — as a constraint

CREATE TABLE work_events (               -- absorbs task_log, poke_log, override requests
  id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL,                     -- 12-value enum per 19 s1c incl. 'poke','override_request','observation'
  payload TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL );

CREATE TABLE adjudications (             -- two-key as rows, not flag columns
  id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL REFERENCES work(id),
  claim_state TEXT NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('upheld','rejected')),
  by_agent TEXT NOT NULL, evidence_ref TEXT, note TEXT, created_at INTEGER NOT NULL );

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — `turns`: ONE column that meant two things becomes two columns that each mean one.
--
-- `outcome` conflated "why the turn ended" with "did the person hear from us". The engine
-- then re-derived the second fact at ~29 sites from nine other variables. Split:
--
--   exit_reason  — WHY it ended. 17 values, COUNTED off the source enumeration
--                  (archive/previous-agent-docs/DOJO-REBUILD-MAP.md:650-653) rather than
--                  taken from research 19 s1c's prose, which says 18 and is wrong:
--                    answered, no_reply_intended, park, handoff, delegation_exit,
--                    iteration_cap, brake, identical_call, stop, preempt, provider_error,
--                    stream_idle, abort, terminated, budget, compile_pending, unknown
--   answered     — DID a genuine user-facing reply get delivered. 0/1, NOT NULL, NO DEFAULT:
--                  the writer must say, because "we forgot to record it" and "nothing was
--                  delivered" are the two facts this platform kept confusing.
--   effectful_calls — the counted non-idempotent call count. P3/P6b read it to decide whether
--                  an aborted turn's claim may be reverted; before this column that was
--                  inferred, and an inference cannot be trusted to re-run someone's payment.
--
-- The paired-nullability CHECK is lifted from research 19 s1a ("highest-value single idiom",
-- MAP:653-655): a turn that ended without recording why is now unrepresentable rather than
-- merely discouraged. Live data was checked first: on this box ended_at IS NULL and
-- outcome IS NULL agree on all 1,303 rows (17 open, 0 half-written), so the CHECK admits the
-- existing body exactly.
--
-- Backfill vocabulary, stated because it is a translation and translations lose things:
--   answered -> (answered, 1)   no_reply -> (no_reply_intended, 0)   parked -> (park, 0)
--   handoff  -> (handoff, 0)    brake    -> (brake, 0)
--   error    -> (unknown, 0)  <- DELIBERATE. The injury path (recovery.ts recordInjury) does
--                               not know whether the cause was the provider, the model, or a
--                               bug; 'unknown' is the enum's quarantine value and is what we
--                               can honestly say. Inventing 'provider_error' would be
--                               manufacturing a distinction the old column never carried.
--   NULL     -> (NULL, 0)       (open turns; the paired CHECK keeps them consistent)

CREATE TABLE turns_new (
  agent_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  kind TEXT,
  subject_kind TEXT,
  subject_id TEXT,
  root_kind TEXT,
  root_id TEXT,
  source_message_id TEXT,
  conv_key TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN (
      'answered','no_reply_intended','park','handoff','delegation_exit','iteration_cap',
      'brake','identical_call','stop','preempt','provider_error','stream_idle','abort',
      'terminated','budget','compile_pending','unknown')),
  answered INTEGER NOT NULL CHECK (answered IN (0,1)),
  effectful_calls INTEGER NOT NULL DEFAULT 0,
  answer_message_id TEXT,
  lane TEXT,
  -- UNIQUE(agent_id, turn_number) is what the plan asks for; it is spelled as the PRIMARY
  -- KEY because that is what the table already had and a separate UNIQUE index beside an
  -- identical PK would be exactly the duplicate-mechanism disease this phase deletes.
  PRIMARY KEY (agent_id, turn_number),
  CHECK ((ended_at IS NULL) = (exit_reason IS NULL))
);

INSERT INTO turns_new (
  agent_id, turn_number, kind, subject_kind, subject_id, root_kind, root_id,
  source_message_id, conv_key, started_at, ended_at, exit_reason, answered,
  effectful_calls, answer_message_id, lane
)
SELECT
  t.agent_id, t.turn_number, t.kind, t.subject_kind, t.subject_id, t.root_kind, t.root_id,
  t.source_message_id, t.conv_key, t.started_at, t.ended_at,
  CASE t.outcome
    WHEN 'answered' THEN 'answered'
    WHEN 'no_reply' THEN 'no_reply_intended'
    WHEN 'parked'   THEN 'park'
    WHEN 'handoff'  THEN 'handoff'
    WHEN 'brake'    THEN 'brake'
    WHEN 'aborted'  THEN 'abort'
    WHEN 'error'    THEN 'unknown'
    -- `CASE x WHEN NULL` can never match (NULL = NULL is not true), so the open turns and
    -- any unrecognised value are both handled here, explicitly and differently.
    ELSE CASE WHEN t.outcome IS NULL THEN NULL ELSE 'unknown' END
  END,
  CASE WHEN t.outcome = 'answered' THEN 1 ELSE 0 END,
  0,                                    -- predates the counter; 0 is the honest reading
  t.answer_message_id, t.lane
FROM turns t;

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;

CREATE INDEX idx_turns_root ON turns(root_id) WHERE root_id IS NOT NULL;
CREATE INDEX idx_turns_subject ON turns(agent_id, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX ix_turns_open ON turns(agent_id) WHERE ended_at IS NULL;   -- 19 s1c's partial open-turn index

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 3 — THE LOCAL COPY, WRITTEN CORRECT FOR A LIVED-IN BODY.
--
-- DECISION (PHASE-2 T2, 2026-07-28) — recorded in PHASE-2.md as an AS-BUILT note under
-- Step 4, and repeated here because the reason is a property of this SQL:
--
-- This migration ships. It runs on a lived-in box, AHEAD of the Bridge step `135b`, and
-- ahead of T10's DROP of the renamed tables. Two options existed: write the copy
-- correct-for-lived-in here, or scope it and let `135b` do the real mapping. THIS FILE DOES
-- THE WHOLE TASK/PROJECT MAPPING, and `135b` is left only what this file structurally
-- cannot see (open_loops, a2a_threads/a2a_replies, the park rows in messages.conv_key, and
-- conversation re-resolution). Four reasons, in order of weight:
--
--   1. A SCOPED COPY IS A DATA-LOSS PATH ON ANY BOX THE BRIDGE DOES NOT REACH. `135b` lives
--      outside this repository until release. T10's DROP of `legacy_tasks` is IN this chain.
--      So on a developer or beta box that runs the local chain without the Bridge, rows this
--      file declined to copy would be dropped by T10 with nothing to catch them.
--   2. ONE MAPPING, ONE PLACE, EXERCISED EVERYWHERE. A lived-in mapping that only ever runs
--      at a release gate is rehearsed once a phase; this one runs on every box, every day.
--   3. NO SPLIT-BRAIN. Ids are preserved, so a two-file copy needs `135b` to know exactly
--      which ids `135` already took or its INSERT collides on the primary key.
--   4. The `135b` skeleton is simpler to write and to review when it adds rows rather than
--      completing a half-finished mapping it has to reconstruct.
--
-- Consequence for T12 / Bridge Entry 12, stated so it is not discovered late: Entry 12's
-- migration does NOT map legacy_tasks/legacy_projects state. It reads them only for
-- linkage, and it REUSES the legacy-closure delivery shape defined below rather than
-- inventing a second sentinel mechanism.
--
-- ── 3a. WHY `complete` CANNOT SIMPLY BECOME `done`, AND WHAT IS DONE INSTEAD ──
--
-- `CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)` is the point of this phase:
-- work is done because something was DELIVERED, never because the model said so. A legacy
-- `complete` row has no delivery to point at — measured, not assumed: on the dev body 0 of
-- 44 delivery rows carry root_kind='task', and on the lived-in reference body the tracker
-- closed 50 tasks and 1,481 projects while `deliveries` holds 138 rows from one code path.
--
-- Every alternative was considered and each is worse:
--   * map `complete` -> `open`/`paused`: reopens a year of finished work on upgrade day and
--     puts it in front of the PM ladder. Real harm to a real person.
--   * map `complete` -> `abandoned`/`failed`: tells the user their finished work failed.
--   * add a ninth state: the eight-value vocabulary is what T3-T9 and the behavioural kit
--     are being built against (kit scenario `on-deck-is-not-neglected` names it), so a new
--     state here would be a fork in the vocabulary on day one.
--   * relax the CHECK for migrated rows: deletes the phase's central constraint to store
--     history — exactly the trade T0's D1 refused for the terminated-agent archive.
--
-- So a legacy closure gets a delivery row that is HONEST about being a legacy closure:
-- ONE `deliveries` row per agent, `outcome='migrated'`, `tool='legacy-closure'`. Positive
-- evidence that it cannot be mistaken for delivery evidence — every reader of `deliveries`
-- in the tree was enumerated (git grep -n "FROM deliveries\|JOIN deliveries" -- packages/
-- watchdog/ | grep -v migrations -> 4 sites: outbound-ledger.ts:235,:268,
-- tracker/delivery-evidence.ts:103, tracker/task-stamps.ts:64) and ALL FOUR filter on
-- `outcome = 'delivered'`. A per-TASK sentinel carrying root_id=<task id> would have been
-- the obvious shape and would have been WRONG: it would have manufactured per-task delivery
-- evidence for the PM's own consult path.

INSERT OR IGNORE INTO deliveries (
  id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
  conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail,
  created_at, updated_at
)
SELECT
  'legacy-closure:' || a.agent_id, a.agent_id, NULL, 'legacy-closure', 'none', NULL, NULL,
  NULL, 'migration', '135_work_spine', NULL, NULL, 'migrated',
  'The tracker closed this work before the delivery ledger recorded anything. This row exists so migrated closures can satisfy work.done''s delivery requirement WITHOUT claiming a delivery happened: outcome is ''migrated'', and every reader of this table filters outcome=''delivered''.',
  datetime('now'), datetime('now')
FROM (
  SELECT DISTINCT t.assigned_to AS agent_id
    FROM tasks t WHERE t.status = 'complete' AND t.assigned_to IS NOT NULL
  UNION
  SELECT DISTINCT COALESCE(
           (SELECT t2.assigned_to FROM tasks t2
             WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
             ORDER BY t2.created_at LIMIT 1),
           p.created_by) AS agent_id
    FROM projects p WHERE p.status = 'complete'
) a
WHERE a.agent_id IS NOT NULL;

-- ── 3b. PROJECTS FIRST (tasks reference them as parents) ──
--
-- `projects` has NO agent column at all, so `work.agent_id` is resolved: first task's
-- assignee, else `created_by` (which on both measured bodies is an agent id for all but a
-- handful of rows: 'user' x2 and 'kevin'/'dreamer', which ARE agent ids). Where it lands on
-- a literal 'user', the row is an orphan by construction rather than a lie.
--
-- Status vocabulary MEASURED on the lived-in reference body, not taken from the code's
-- writer set: projects carry `complete` (1,481), `cancelled` (23) and `active` (1) — and
-- `cancelled`/`active` appear in NO writer T0 surveyed. This is why the mapping is a CASE
-- with a default and not a lookup that can fail.
--   active -> open · complete -> done (+ legacy-closure delivery) · cancelled -> abandoned
--   anything unrecognised -> open. Deliberate: surfacing work that may be finished is
--   recoverable; silently terminating work that is live is not. Measured count of rows
--   taking that branch on both bodies: 0.

INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id,
  root_kind, root_id, state, claimed_by_turn, result_delivery_id, intent, wakes,
  closes_thread, hop_count, superseded_by, title, goal, priority, notes, remaining_children,
  compile_pending, ttl_at, reply_conversation_id, attempts, next_attempt_at, schedule_json,
  tz, anchor_local, next_run_at, sequence, opened_at, closed_at, updated_at, provenance
)
SELECT
  p.id, 'project', NULL,
  COALESCE((SELECT t2.assigned_to FROM tasks t2
             WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
             ORDER BY t2.created_at LIMIT 1), p.created_by),
  NULL,
  CASE WHEN p.created_by = 'user' THEN 'owner' ELSE 'agent' END,
  p.created_by,
  NULL,                                    -- conversation_id: see 3d
  'legacy', p.id,
  CASE p.status
    WHEN 'complete'  THEN 'done'
    WHEN 'cancelled' THEN 'abandoned'
    WHEN 'active'    THEN 'open'
    WHEN 'paused'    THEN 'paused'
    WHEN 'blocked'   THEN 'blocked'
    WHEN 'on_deck'   THEN 'on_deck'
    WHEN 'in_progress' THEN 'claimed'
    WHEN 'fallen'    THEN 'failed'
    ELSE 'open'
  END,
  NULL,
  CASE WHEN p.status = 'complete'
       THEN 'legacy-closure:' || COALESCE((SELECT t2.assigned_to FROM tasks t2
                                            WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
                                            ORDER BY t2.created_at LIMIT 1), p.created_by)
       END,
  'legacy', 0, 0, 0, NULL,
  p.title, NULL, NULL, p.description, NULL,
  0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
  COALESCE(CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', p.completed_at) AS INTEGER) * 1000,
           1600000000001),
  CASE WHEN p.status IN ('complete','cancelled','fallen')
       THEN COALESCE(CAST(strftime('%s', p.completed_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
                     1600000000001)
       END,
  COALESCE(CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
           1600000000001),
  'migrated'
FROM projects p;

-- ── 3c. TASKS ──
--
-- `1600000000001` is the floor sentinel for a row whose every timestamp is unreadable. It is
-- one millisecond above the `opened_at` CHECK boundary (2020-09-13) and is deliberately NOT
-- `now`: an ancient row stamped with today's clock would look fresh to every age cliff in
-- the platform. Measured count of rows needing it on both bodies: 0.

INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id,
  root_kind, root_id, state, claimed_by_turn, result_delivery_id, intent, wakes,
  closes_thread, hop_count, superseded_by, title, goal, priority, notes, remaining_children,
  compile_pending, ttl_at, reply_conversation_id, attempts, next_attempt_at, schedule_json,
  tz, anchor_local, next_run_at, sequence, opened_at, closed_at, updated_at, provenance
)
SELECT
  t.id, 'task',
  CASE WHEN t.project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id)
       THEN t.project_id END,
  COALESCE(t.assigned_to, t.created_by),
  NULL,
  CASE WHEN t.created_by = 'user' THEN 'owner' ELSE 'agent' END,
  t.created_by,
  NULL,                                    -- conversation_id: see 3d
  'legacy', t.id,
  CASE t.status
    WHEN 'complete'    THEN 'done'
    WHEN 'in_progress' THEN 'claimed'
    WHEN 'fallen'      THEN 'failed'
    WHEN 'paused'      THEN 'paused'
    WHEN 'blocked'     THEN 'blocked'
    WHEN 'on_deck'     THEN 'on_deck'
    WHEN 'cancelled'   THEN 'abandoned'
    WHEN 'active'      THEN 'open'
    ELSE 'open'
  END,
  NULL,
  CASE WHEN t.status = 'complete'
       THEN 'legacy-closure:' || COALESCE(t.assigned_to, t.created_by) END,
  'legacy', 0, 0, 0, NULL,
  t.title, t.goal, t.priority, t.notes, NULL,
  0, NULL, NULL,
  COALESCE(t.run_count, 0), NULL, NULL, NULL, t.anchor_time,
  CAST(strftime('%s', t.next_run_at) AS INTEGER) * 1000,
  NULL,
  COALESCE(CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
           CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000,
           1600000000001),
  CASE WHEN t.status IN ('complete','fallen','cancelled')
       THEN COALESCE(CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
                     1600000000001)
       END,
  COALESCE(CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
           1600000000001),
  'migrated'
FROM tasks t;

-- ── 3d. WHAT THIS FILE DELIBERATELY DOES NOT MAP, AND WHO OWES IT ──
--
-- `conversation_id` is left NULL for every migrated row. `tasks.origin_conv_key` is a
-- conv_key STRING (`imessage:+1555...`), not a `conversations.id`, and guessing the join
-- would put a wrong FK on the spine's first day. The Bridge's conversation-resolution
-- ladder (STABLE-BRIDGE Entry 9, MAP:1209-1217) is the mechanism that already exists for
-- exactly this, and it runs at `135b`. Recorded in Bridge Entry 12 as owed, not forgotten.
--
-- `schedule_json` / `tz` / `sequence` are left NULL: the repeat_* columns are a different
-- shape and T9 owns the schedule rebuild. `occurrence` rows are created by T9, not here,
-- which is why `ux_work_occurrence` has nothing to bite on yet and is proven by test instead.

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 4 — THE RENAME. Phase-1's discipline: a missed reader fails LOUD instead of quietly
-- reading a stale twin. T10 drops both tables; between now and then `legacy_tasks` is where
-- the un-migrated writers still live, and every one of them is visible because it had to be
-- re-pointed by name.

ALTER TABLE tasks RENAME TO legacy_tasks;
ALTER TABLE projects RENAME TO legacy_projects;
