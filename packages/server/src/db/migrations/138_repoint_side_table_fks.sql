-- ════════════════════════════════════════════════════════════════════════════════════════
-- PHASE-2 T8b — the tracker's four side tables stop pointing at the table it just left.
--
-- WHY THIS FILE EXISTS. T8b moved the tracker's rows onto `work`. Four tables hang off a
-- task and each declares `task_id TEXT NOT NULL REFERENCES "legacy_tasks"(id)`, while
-- `db/connection.ts:25` runs `PRAGMA foreign_keys = ON`. A task id that lives only in
-- `work` therefore cannot be written to any of them — measured on a VACUUM INTO copy of the
-- live box: four INSERTs, four `FOREIGN KEY constraint failed (19)`. The worst of the four
-- is `task_log`, whose writer is best-effort and SWALLOWS the violation: the tracker's audit
-- trail would simply stop recording and nothing would say so. That is what stopped T8b, and
-- the orchestrator's RULING 3 (Phase-2 ledger, 2026-07-29) is this migration.
--
-- SQLite cannot alter a foreign key in place, so each table is rebuilt: create the new
-- shape, copy every row, drop, rename, recreate the indexes. The migration runner holds
-- `foreign_keys = OFF` across the whole chain (`db/migrations.ts:146-148`) and wraps each
-- file in one transaction (`:159`), so the drop/rename is safe and atomic.
--
-- THE FOUR TABLES STILL DIE AT T10. Research 19 §1c and Part III both fold `task_log`,
-- `task_runs` and `task_override_requests` into `work_events` ("absorbs task_log, poke_log,
-- override requests" is that table's own DDL comment), and T10 drops them with
-- `legacy_tasks`. This file is the honest INTERIM for the gap between the rows moving (T8b)
-- and the absorption landing (T9/T10) — a gap nobody had written down. T10's drop list must
-- know these four now have a different DDL than the one it was written against.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ PART 1 EXISTS BECAUSE THE RULING'S OWN ASSERTION WAS FALSE ON CONTACT
--
-- RULING 3 says to assert that every existing `task_id` resolves in `work` — "T2 carried ids
-- 1:1; assert it, don't assume it". Asserted, and it does NOT hold on this box:
--
--   SELECT count(*) FROM legacy_tasks    t WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id=t.id) -> 31
--   SELECT count(*) FROM legacy_projects p WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id=p.id) -> 30
--   SELECT count(*) FROM task_log        l WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id=l.task_id) -> 99
--
-- T2 DID carry the ids 1:1 — at the instant `135` ran. What broke it is the WINDOW: `135`
-- backfilled, and then the pre-T8b application code kept creating rows in `legacy_tasks` for
-- another day, and those have no twin. On a real upgrade the window cannot open (a boot runs
-- 135→138 with no application code in between); on every DEVELOPER box in this rebuild it is
-- already open.
--
-- Two consequences, and the second is the serious one:
--   1. re-pointing the FK alone would strand 99 `task_log` rows, and
--   2. **those 61 tracker rows would VANISH from the board**, because T8b's readers read
--      `work`. That is silent data loss, and it is not acceptable just because the upgrade
--      path is theoretically immune (#15: handle what is measured, not what is assumed).
--
-- So Part 1 adopts the twinless rows into `work` using migration `135`'s OWN mapping, lifted
-- from that file rather than re-typed, plus `137`'s attribute columns. It is idempotent by
-- construction (`WHERE NOT EXISTS`), so a box with no window adopts nothing and the whole of
-- Part 1 is a no-op there.
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── 1a. THE LEGACY-CLOSURE DELIVERY, reused rather than reinvented ──────────────────────
-- `CHECK (state <> 'done' OR result_delivery_id IS NOT NULL)` is the point of this phase, and
-- a legacy closure has no delivery to point at. `135` answered that with ONE row per agent,
-- `outcome='migrated'`, `tool='legacy-closure'` — positive evidence that cannot be mistaken
-- for delivery evidence, because all four readers of `deliveries` filter `outcome='delivered'`.
-- Its own header instructs later files to REUSE that shape rather than invent a second
-- sentinel mechanism, so this does. `INSERT OR IGNORE` because `135` already made most of them.
INSERT OR IGNORE INTO deliveries (
  id, agent_id, turn_number, tool, channel, recipient_id, recipient_display,
  conversation_id, root_kind, root_id, message_id, receipt_id, outcome, detail,
  created_at, updated_at
)
SELECT
  'legacy-closure:' || a.agent_id, a.agent_id, NULL, 'legacy-closure', 'none', NULL, NULL,
  NULL, 'migration', '138_repoint_side_table_fks', NULL, NULL, 'migrated',
  'The tracker closed this work before the delivery ledger recorded anything. This row exists so migrated closures can satisfy work.done''s delivery requirement WITHOUT claiming a delivery happened: outcome is ''migrated'', and every reader of this table filters outcome=''delivered''.',
  datetime('now'), datetime('now')
FROM (
  SELECT DISTINCT COALESCE(t.assigned_to, t.created_by) AS agent_id
    FROM legacy_tasks t
   WHERE t.status = 'complete'
     AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = t.id)
  UNION
  SELECT DISTINCT COALESCE(
           (SELECT t2.assigned_to FROM legacy_tasks t2
             WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
             ORDER BY t2.created_at LIMIT 1),
           p.created_by) AS agent_id
    FROM legacy_projects p
   WHERE p.status = 'complete'
     AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = p.id)
) a
WHERE a.agent_id IS NOT NULL;

-- ⚠ THE FLOOR IS CLAMPED, NOT JUST DEFAULTED — and the rehearsal is why.
-- `work.opened_at` carries `CHECK (opened_at > 1600000000000)`. Migration `135` used a bare
-- COALESCE ladder ending in the sentinel `1600000000001`, which handles an UNREADABLE
-- instant but NOT a readable one that lands below the floor: a `created_at` of
-- '1999-01-01' parses fine, converts to 915148800000, and fails the CHECK — which aborts the
-- whole migration and, in a real boot, the whole startup. `135`'s own note records "measured
-- count of rows needing it on both bodies: 0", so it never met one; the adversarial body here
-- plants one deliberately and it aborted this file on the first run.
-- `MAX(..., 1600000000001)` keeps the row instead of taking the boot down. It is the same
-- sentinel doing the same job for one more case: an instant this schema cannot represent
-- becomes the floor, and the row survives. Recorded for the Bridge author, because `135`
-- carries the identical latent hazard on any lived-in body holding a pre-2020 timestamp.

-- ── 1b. PROJECTS FIRST (tasks reference them as parents) ────────────────────────────────
INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id,
  root_kind, root_id, state, claimed_by_turn, result_delivery_id, intent, wakes,
  closes_thread, hop_count, superseded_by, title, goal, priority, notes, remaining_children,
  compile_pending, ttl_at, reply_conversation_id, attempts, next_attempt_at,
  opened_at, closed_at, updated_at, provenance,
  description, level, phase_count, current_phase, group_id,
  source_message_id, origin_turn, origin_conv_key, origin_kind
)
SELECT
  p.id, 'project', NULL,
  COALESCE((SELECT t2.assigned_to FROM legacy_tasks t2
             WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
             ORDER BY t2.created_at LIMIT 1), p.created_by),
  NULL,
  CASE WHEN p.created_by = 'user' THEN 'owner' ELSE 'agent' END,
  p.created_by,
  NULL,
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
       THEN 'legacy-closure:' || COALESCE((SELECT t2.assigned_to FROM legacy_tasks t2
                                            WHERE t2.project_id = p.id AND t2.assigned_to IS NOT NULL
                                            ORDER BY t2.created_at LIMIT 1), p.created_by)
       END,
  'legacy', 0, 0, 0, NULL,
  p.title, NULL, NULL, NULL, NULL,
  0, NULL, NULL, 0, NULL,
  MAX(COALESCE(CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
               CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
               CAST(strftime('%s', p.completed_at) AS INTEGER) * 1000,
               1600000000001), 1600000000001),
  CASE WHEN p.status IN ('complete','cancelled','fallen')
       THEN COALESCE(CAST(strftime('%s', p.completed_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
                     1600000000001)
       END,
  COALESCE(CAST(strftime('%s', p.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', p.created_at) AS INTEGER) * 1000,
           1600000000001),
  'migrated',
  p.description, p.level, p.phase_count, p.current_phase, p.group_id,
  p.source_message_id, p.origin_turn, p.origin_conv_key, p.origin_kind
FROM legacy_projects p
WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = p.id);

-- ── 1c. TASKS ───────────────────────────────────────────────────────────────────────────
INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id,
  root_kind, root_id, state, claimed_by_turn, result_delivery_id, intent, wakes,
  closes_thread, hop_count, superseded_by, title, goal, priority, notes, remaining_children,
  compile_pending, ttl_at, reply_conversation_id, attempts, next_attempt_at,
  anchor_local, next_run_at,
  opened_at, closed_at, updated_at, provenance,
  description, original_description, completion_summary, result, evidence_json,
  step_number, total_steps, phase, depends_on, assigned_to_group, task_kind,
  source_message_id, origin_turn, origin_conv_key, origin_kind,
  deliverable_shown, a2a_thread_id, last_smell_flag,
  scheduled_start, repeat_interval, repeat_unit, repeat_end_type, repeat_end_value,
  repeat_days_of_week, schedule_status, is_paused, paused_until, status_before_pause,
  last_run_at, missed_runs_paused_at,
  last_activity_turn, last_activity_at, last_activity_outcome,
  last_answered_turn, last_answered_at, last_delivery_summary
)
SELECT
  t.id, 'task',
  CASE WHEN t.project_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM work wp WHERE wp.id = t.project_id AND wp.kind = 'project')
       THEN t.project_id END,
  COALESCE(t.assigned_to, t.created_by),
  NULL,
  CASE WHEN t.created_by = 'user' THEN 'owner' ELSE 'agent' END,
  t.created_by,
  NULL,
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
  COALESCE(t.run_count, 0), NULL,
  t.anchor_time,
  CAST(strftime('%s', t.next_run_at) AS INTEGER) * 1000,
  MAX(COALESCE(CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
               CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
               CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000,
               1600000000001), 1600000000001),
  CASE WHEN t.status IN ('complete','fallen','cancelled')
       THEN COALESCE(CAST(strftime('%s', t.completed_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
                     CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
                     1600000000001)
       END,
  COALESCE(CAST(strftime('%s', t.updated_at) AS INTEGER) * 1000,
           CAST(strftime('%s', t.created_at) AS INTEGER) * 1000,
           1600000000001),
  'migrated',
  t.description, t.original_description, t.completion_summary, t.result, t.evidence_json,
  t.step_number, t.total_steps, t.phase, t.depends_on, t.assigned_to_group, t.kind,
  t.source_message_id, t.origin_turn, t.origin_conv_key, t.origin_kind,
  COALESCE(t.deliverable_shown, 0), t.a2a_thread_id, t.last_smell_flag,
  CAST(strftime('%s', t.scheduled_start) AS INTEGER) * 1000,
  t.repeat_interval, t.repeat_unit, t.repeat_end_type, t.repeat_end_value,
  t.repeat_days_of_week, t.schedule_status, COALESCE(t.is_paused, 0),
  CAST(strftime('%s', t.paused_until) AS INTEGER) * 1000,
  t.status_before_pause,
  CAST(strftime('%s', t.last_run_at) AS INTEGER) * 1000,
  CAST(strftime('%s', t.missed_runs_paused_at) AS INTEGER) * 1000,
  t.last_activity_turn,
  CAST(strftime('%s', t.last_activity_at) AS INTEGER) * 1000,
  t.last_activity_outcome,
  t.last_answered_turn,
  CAST(strftime('%s', t.last_answered_at) AS INTEGER) * 1000,
  t.last_delivery_summary
FROM legacy_tasks t
WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = t.id);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PART 2 — THE REBUILDS. Same shape, same indexes, one word changed in each.
-- ════════════════════════════════════════════════════════════════════════════════════════

-- ── task_log ────────────────────────────────────────────────────────────────────────────
CREATE TABLE task_log_new (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  from_entity     TEXT NOT NULL,
  entry_kind      TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  reason          TEXT,
  action_taken    TEXT,
  note            TEXT,
  evidence_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_log_new (id, task_id, from_entity, entry_kind, from_status, to_status,
                          reason, action_taken, note, evidence_json, created_at)
  SELECT id, task_id, from_entity, entry_kind, from_status, to_status,
         reason, action_taken, note, evidence_json, created_at FROM task_log;
DROP TABLE task_log;
ALTER TABLE task_log_new RENAME TO task_log;
CREATE INDEX idx_task_log_task_id ON task_log(task_id, created_at);
CREATE INDEX idx_task_log_kind ON task_log(entry_kind, created_at);
CREATE INDEX idx_task_log_entity ON task_log(from_entity, created_at);

-- ── task_runs ───────────────────────────────────────────────────────────────────────────
CREATE TABLE task_runs_new (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES work(id),
  run_number      INTEGER NOT NULL,
  scheduled_for   TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  assigned_to     TEXT REFERENCES agents(id),
  result_summary  TEXT,
  tokens_used     INTEGER,
  cost_usd        REAL,
  error           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
INSERT INTO task_runs_new (id, task_id, run_number, scheduled_for, started_at, completed_at,
                           status, assigned_to, result_summary, tokens_used, cost_usd, error, created_at)
  SELECT id, task_id, run_number, scheduled_for, started_at, completed_at,
         status, assigned_to, result_summary, tokens_used, cost_usd, error, created_at FROM task_runs;
DROP TABLE task_runs;
ALTER TABLE task_runs_new RENAME TO task_runs;
CREATE INDEX idx_task_runs_task ON task_runs(task_id, run_number);
CREATE INDEX idx_task_runs_scheduled ON task_runs(scheduled_for);

-- ── poke_log ────────────────────────────────────────────────────────────────────────────
CREATE TABLE poke_log_new (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES work(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  poke_number       INTEGER NOT NULL,
  poke_type         TEXT NOT NULL,
  sent_at           TEXT DEFAULT (datetime('now')),
  response_received INTEGER DEFAULT 0
);
INSERT INTO poke_log_new (id, task_id, agent_id, poke_number, poke_type, sent_at, response_received)
  SELECT id, task_id, agent_id, poke_number, poke_type, sent_at, response_received FROM poke_log;
DROP TABLE poke_log;
ALTER TABLE poke_log_new RENAME TO poke_log;
CREATE INDEX idx_poke_log_task ON poke_log(task_id, poke_number);

-- ── task_override_requests ──────────────────────────────────────────────────────────────
CREATE TABLE task_override_requests_new (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  requested_by        TEXT NOT NULL,
  requested_status    TEXT NOT NULL,
  justification       TEXT NOT NULL,
  last_engine_error   TEXT,
  attempts_attached   INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'approved', 'denied', 'auto_denied')),
  resolved_by         TEXT,
  resolved_reason     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT
);
INSERT INTO task_override_requests_new (id, task_id, requested_by, requested_status, justification,
                                        last_engine_error, attempts_attached, status,
                                        resolved_by, resolved_reason, created_at, resolved_at)
  SELECT id, task_id, requested_by, requested_status, justification,
         last_engine_error, attempts_attached, status,
         resolved_by, resolved_reason, created_at, resolved_at FROM task_override_requests;
DROP TABLE task_override_requests;
ALTER TABLE task_override_requests_new RENAME TO task_override_requests;
CREATE INDEX idx_override_requests_status ON task_override_requests(status, created_at);
CREATE INDEX idx_override_requests_task ON task_override_requests(task_id, status);
CREATE UNIQUE INDEX idx_override_requests_one_pending_per_agent_task
  ON task_override_requests(task_id, requested_by)
  WHERE status = 'pending';
