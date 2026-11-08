-- 901: one path to done. Classifies every board task and project from its old records, rebuilds
-- work_events (the hand-in and decision kinds) and work (the hold columns, the board-state CHECK,
-- the dead columns gone), maps each row to the new states with history appended and no wake, drops
-- the retired sensei switches, the dead turn_artifacts link and the decision model's unread records,
-- and aborts unless every assertion holds.
-- The counts per class land in config.task_done_upgrade_last.
-- REQUIRES-COLUMN: work.status_before_pause

CREATE TEMP TABLE _td_now AS SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS ms;

-- 1. Classify, from the old records, before anything is rebuilt. A payload that is not JSON reads as empty.
CREATE TEMP TABLE _td_ev AS
SELECT id, work_id, kind, CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS payload FROM work_events
 WHERE kind IN ('validation_requested','claim_rejected','claim_upheld','transition','user_verdict_requested',
                'user_verdict_cleared','override_request','override_resolved');
CREATE INDEX _td_ev_work ON _td_ev(work_id, kind);
CREATE TEMP TABLE _td_facts AS
SELECT w.id, w.kind, w.state AS from_state, w.goal, w.description, w.title,
       (w.repeat_interval IS NOT NULL OR w.schedule_json IS NOT NULL) AS recurring,
       COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'validation_requested'
                   AND json_extract(e.payload, '$.requested_state') = 'done'), -1)
         > COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND (e.kind = 'claim_rejected'
                   OR (e.kind = 'transition' AND json_extract(e.payload, '$.to') IN ('done','failed','abandoned','open')))), -1) AS close_filed,
       COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'user_verdict_requested'), -1)
         > COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'user_verdict_cleared'), -1) AS verdict_open,
       COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'override_request'), -1)
         > COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'override_resolved'), -1) AS override_open,
       COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'claim_rejected'
                   AND json_extract(e.payload, '$.claim_state') = 'done'), -1)
         > COALESCE((SELECT MAX(e.id) FROM _td_ev e WHERE e.work_id = w.id
                   AND e.kind IN ('validation_requested','claim_upheld','transition')), -1) AS rejected_newest,
       (SELECT json_extract(e.payload, '$.reason') FROM _td_ev e WHERE e.work_id = w.id AND e.kind = 'transition'
           AND json_extract(e.payload, '$.to') = w.state ORDER BY e.id DESC LIMIT 1) AS entry_reason,
       (SELECT COUNT(*) FROM work c WHERE c.parent_id = w.id AND c.kind = 'task' AND c.root_kind IN ('legacy','tracker','engine_scaffold')) AS tasks,
       (SELECT COUNT(*) FROM work c WHERE c.parent_id = w.id AND c.kind = 'task' AND c.root_kind IN ('legacy','tracker','engine_scaffold') AND c.state = 'done') AS tasks_done,
       (SELECT COUNT(*) FROM work c WHERE c.parent_id = w.id AND c.kind = 'task' AND c.root_kind IN ('legacy','tracker','engine_scaffold') AND c.state = 'abandoned') AS tasks_cancelled,
       (SELECT c.result_delivery_id FROM work c WHERE c.parent_id = w.id AND c.kind = 'task' AND c.root_kind IN ('legacy','tracker','engine_scaffold')
           AND c.state = 'done' ORDER BY c.closed_at DESC, c.id DESC LIMIT 1) AS newest_done_delivery
  FROM work w
 WHERE w.kind IN ('task','project') AND w.root_kind IN ('legacy','tracker','engine_scaffold');

CREATE TEMP TABLE _td_map (
  id TEXT PRIMARY KEY, class TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
  hold_kind TEXT, hold_reason TEXT, rehandin INTEGER NOT NULL, clear_verdict INTEGER NOT NULL,
  clear_override INTEGER NOT NULL, pause_schedule INTEGER NOT NULL, goal_from TEXT, settle_on TEXT
);
INSERT INTO _td_map
SELECT id, class, from_state,
       CASE WHEN class IN ('rehandin','rehandin_recurring','paused','blocked','project_working') THEN 'claimed'
            WHEN class = 'sent_back' THEN 'sent_back'
            WHEN class = 'project_done' THEN 'done'
            WHEN class = 'project_abandoned' THEN 'abandoned'
            WHEN class IN ('on_deck','project_paused','project_blocked') OR from_state = 'on_deck' THEN 'open'
            ELSE from_state END,
       hold, CASE WHEN hold IS NOT NULL THEN COALESCE(NULLIF(trim(replace(replace(entry_reason, char(10), ' '), char(13), ' ')), ''), from_state) END,
       class IN ('rehandin','rehandin_recurring'), live AND verdict_open, live AND override_open,
       class = 'rehandin_recurring',
       CASE WHEN live AND NULLIF(trim(COALESCE(goal, '')), '') IS NULL THEN
              CASE WHEN NULLIF(trim(COALESCE(description, '')), '') IS NOT NULL THEN 'description'
                   WHEN NULLIF(trim(COALESCE(title, '')), '') IS NOT NULL THEN 'title' END END,
       CASE WHEN class = 'project_done' THEN newest_done_delivery END
  FROM (
    SELECT f.*, (f.from_state NOT IN ('done','failed','abandoned')) AS live,
           CASE WHEN f.from_state IN ('done','failed','abandoned') THEN 'history_' || f.from_state
                WHEN f.kind = 'task' AND (f.close_filed OR f.verdict_open OR f.override_open) THEN
                  CASE WHEN f.close_filed AND f.recurring THEN 'rehandin_recurring' ELSE 'rehandin' END
                WHEN f.kind = 'task' AND f.rejected_newest THEN 'sent_back'
                WHEN f.kind = 'task' AND f.from_state IN ('paused','blocked','on_deck') THEN f.from_state
                WHEN f.kind = 'task' THEN f.from_state
                WHEN f.tasks = 0 THEN CASE f.from_state WHEN 'paused' THEN 'project_paused' WHEN 'blocked' THEN 'project_blocked' ELSE 'project_empty' END
                WHEN f.tasks_done + f.tasks_cancelled < f.tasks THEN 'project_working'
                WHEN f.tasks_done > 0 THEN 'project_done'
                ELSE 'project_abandoned' END AS class,
           CASE WHEN f.from_state IN ('paused','blocked') AND NOT (f.kind = 'task' AND (f.close_filed OR f.verdict_open OR f.override_open))
                 AND NOT (f.kind = 'project' AND f.tasks > 0 AND f.tasks_done + f.tasks_cancelled = f.tasks)
                THEN f.from_state END AS hold
      FROM _td_facts f
  );

-- 2. The census before, and the pre-image the no-wake assertions compare against.
CREATE TEMP TABLE _td_before AS SELECT class, COUNT(*) AS n FROM _td_map GROUP BY class;
CREATE TEMP TABLE _td_wake AS SELECT id, wakes, ttl_at, next_attempt_at, next_run_at, is_paused, schedule_status FROM work;
CREATE TEMP TABLE _td_rest AS SELECT state, COUNT(*) AS n FROM work WHERE NOT EXISTS (SELECT 1 FROM _td_map m WHERE m.id = work.id) GROUP BY state;
CREATE TEMP TABLE _td_counts AS SELECT
  (SELECT COUNT(*) FROM deliveries) AS deliveries, (SELECT COUNT(*) FROM messages) AS messages,
  (SELECT COUNT(*) FROM work_events) AS events, (SELECT COALESCE(MAX(id), 0) FROM work_events) AS max_event,
  (SELECT COUNT(*) FROM adjudications) AS adjudications;

-- 3. work_events gains the hand-in and decision kinds; every old kind stays legal for its rows.
CREATE TABLE work_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL REFERENCES work(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'activity','audit','child_settled','claim_rejected','claim_turn','claim_upheld',
    'compile_resolved','continued','decided','floor_ghosted','hand_in_refused','handed_in',
    'join_complete','join_opened','measured','occurrence_fired','occurrence_released','occurrence_settled',
    'opened','override_request','override_resolved','owed_interrupt','person_told','poke',
    'poke_remediation','proof_opened','rearm_refused','revert_reset','stalled','transition',
    'user_verdict_cleared','user_verdict_requested','validation_escalated','validation_requested'
  )),
  payload TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO work_events_new (id, work_id, kind, payload, actor, created_at)
SELECT id, work_id, kind, payload, actor, created_at FROM work_events;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'work_events_new', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'work_events_new');
UPDATE sqlite_sequence
   SET seq = (SELECT MAX(COALESCE(seq, 0)) FROM sqlite_sequence WHERE name IN ('work_events', 'work_events_new'))
 WHERE name = 'work_events_new';
DROP TABLE work_events;
ALTER TABLE work_events_new RENAME TO work_events;
CREATE INDEX IF NOT EXISTS idx_work_events_work_id ON work_events(work_id, kind, created_at);

-- 4. work is rebuilt once: the hold columns, the board-state CHECK, and the dead columns gone.
DROP TRIGGER IF EXISTS deliveries_done_evidence_no_delete;
DROP TRIGGER IF EXISTS two_key_completion;

CREATE TABLE work_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ask','task','project','occurrence','commitment')),
  parent_id TEXT REFERENCES work(id),
  agent_id TEXT NOT NULL, assignee_agent TEXT,   -- no foreign key: work outlives its agent
  requester TEXT NOT NULL CHECK (requester IN ('owner','agent','schedule','watcher')),
  requester_id TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  root_kind TEXT NOT NULL, root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','claimed','handed_in','sent_back','done','failed','abandoned','paused','blocked','on_deck')),
  claimed_by_turn INTEGER,
  result_delivery_id TEXT REFERENCES deliveries(id),
  intent TEXT NOT NULL,
  wakes INTEGER NOT NULL, closes_thread INTEGER NOT NULL,
  hop_count INTEGER NOT NULL DEFAULT 0, superseded_by TEXT,
  title TEXT, goal TEXT, priority TEXT, notes TEXT,
  remaining_children INTEGER,
  compile_pending INTEGER NOT NULL DEFAULT 0,
  ttl_at INTEGER, reply_conversation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  schedule_json TEXT, tz TEXT, anchor_local TEXT, next_run_at INTEGER, sequence INTEGER,
  opened_at INTEGER NOT NULL CHECK (opened_at > 1600000000000),
  closed_at INTEGER, updated_at INTEGER NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','migrated','rescued')),
  description TEXT, original_description TEXT, result TEXT, evidence_json TEXT, step_number INTEGER,
  total_steps INTEGER, phase INTEGER, depends_on TEXT, assigned_to_group TEXT, task_kind TEXT, level INTEGER,
  phase_count INTEGER, current_phase INTEGER, group_id TEXT, source_message_id TEXT, origin_turn INTEGER,
  origin_conv_key TEXT, origin_kind TEXT, a2a_thread_id TEXT, scheduled_start INTEGER, repeat_interval INTEGER,
  repeat_unit TEXT, repeat_end_type TEXT, repeat_end_value TEXT, repeat_days_of_week TEXT, schedule_status TEXT,
  is_paused INTEGER NOT NULL DEFAULT 0, paused_until INTEGER, last_run_at INTEGER, missed_runs_paused_at INTEGER,
  measure_json TEXT, measure_initial INTEGER, measure_remaining INTEGER, measure_at INTEGER, plan_json TEXT,
  hold_kind TEXT CHECK (hold_kind IN ('paused','blocked')), hold_reason TEXT, hold_at INTEGER,
  CHECK ((state IN ('done','failed','abandoned')) = (closed_at IS NOT NULL)),
  CHECK (state <> 'done' OR result_delivery_id IS NOT NULL),
  CHECK (kind <> 'project' OR parent_id IS NULL),
  CHECK (kind NOT IN ('task','project') OR state IN ('open','claimed','handed_in','sent_back','done','failed','abandoned'))
);

-- 5. The copy, with each board row's mapping applied as it lands.
INSERT INTO work_new (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id, conversation_id, root_kind, root_id,
  state, claimed_by_turn, result_delivery_id, intent, wakes, closes_thread, hop_count, superseded_by,
  title, goal, priority, notes, remaining_children, compile_pending, ttl_at, reply_conversation_id,
  attempts, next_attempt_at, schedule_json, tz, anchor_local, next_run_at, sequence, opened_at, closed_at,
  updated_at, provenance, description, original_description, result, evidence_json, step_number, total_steps,
  phase, depends_on, assigned_to_group, task_kind, level, phase_count, current_phase, group_id,
  source_message_id, origin_turn, origin_conv_key, origin_kind, a2a_thread_id, scheduled_start,
  repeat_interval, repeat_unit, repeat_end_type, repeat_end_value, repeat_days_of_week, schedule_status,
  is_paused, paused_until, last_run_at, missed_runs_paused_at, measure_json, measure_initial,
  measure_remaining, measure_at, plan_json, hold_kind, hold_reason, hold_at
)
SELECT
  w.id, w.kind, w.parent_id, w.agent_id, w.assignee_agent, w.requester, w.requester_id, w.conversation_id, w.root_kind, w.root_id,
  COALESCE(m.to_state, w.state), w.claimed_by_turn,
  CASE WHEN m.class = 'project_done' THEN m.settle_on ELSE w.result_delivery_id END,
  w.intent, w.wakes, w.closes_thread, w.hop_count, w.superseded_by,
  w.title,
  CASE m.goal_from WHEN 'description' THEN trim(w.description) WHEN 'title' THEN trim(w.title) ELSE w.goal END,
  w.priority, w.notes, w.remaining_children, w.compile_pending, w.ttl_at, w.reply_conversation_id,
  w.attempts, w.next_attempt_at, w.schedule_json, w.tz, w.anchor_local, w.next_run_at, w.sequence, w.opened_at,
  CASE WHEN m.to_state IN ('done','abandoned') AND m.from_state NOT IN ('done','failed','abandoned') THEN (SELECT ms FROM _td_now) ELSE w.closed_at END,
  w.updated_at, w.provenance, w.description, w.original_description, w.result, w.evidence_json, w.step_number, w.total_steps,
  w.phase, w.depends_on, w.assigned_to_group, w.task_kind, w.level, w.phase_count, w.current_phase, w.group_id,
  w.source_message_id, w.origin_turn, w.origin_conv_key, w.origin_kind, w.a2a_thread_id, w.scheduled_start,
  w.repeat_interval, w.repeat_unit, w.repeat_end_type, w.repeat_end_value, w.repeat_days_of_week,
  CASE WHEN m.pause_schedule THEN 'paused' ELSE w.schedule_status END,
  CASE WHEN m.pause_schedule THEN 1 ELSE w.is_paused END,
  w.paused_until, w.last_run_at, w.missed_runs_paused_at, w.measure_json, w.measure_initial,
  w.measure_remaining, w.measure_at, w.plan_json, m.hold_kind, m.hold_reason, CASE WHEN m.hold_kind IS NOT NULL THEN w.updated_at END
FROM work w LEFT JOIN _td_map m ON m.id = w.id;
DROP TABLE work;
ALTER TABLE work_new RENAME TO work;

CREATE INDEX ix_work_children_order ON work(parent_id, step_number) WHERE kind = 'task';
CREATE INDEX ix_work_due ON work(schedule_status, is_paused, next_run_at) WHERE schedule_status IS NOT NULL;
CREATE INDEX ix_work_queue ON work(agent_id, state, kind);
CREATE INDEX ix_work_root ON work(root_kind, root_id);
CREATE UNIQUE INDEX ux_work_occurrence ON work(parent_id, sequence) WHERE kind='occurrence';

-- 6. History appended, never rewritten: one transition per changed state, one entry per mapped live
--    row, the re-hand-in hint, and one answer to each open owner-verdict or override request.
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT m.id, 'transition', json_object('from', m.from_state, 'to', m.to_state, 'by', 'engine',
         'reason', 'upgrade: ' || m.from_state || ' becomes ' || m.to_state, 'evidence_ref', NULL,
         'result_delivery_id', m.settle_on, 'claim', NULL, 'note', NULL), 'migration-901', n.ms
  FROM _td_map m, _td_now n WHERE m.from_state <> m.to_state ORDER BY m.id;
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT m.id, 'audit', json_object('entry_kind', 'upgrade_mapped', 'from_status', m.from_state, 'to_status', m.to_state,
         'reason', m.class, 'action_taken', CASE WHEN m.goal_from IS NOT NULL THEN 'goal from ' || m.goal_from END,
         'note', NULL, 'evidence_json', NULL), 'migration-901', n.ms
  FROM _td_map m, _td_now n WHERE m.from_state NOT IN ('done','failed','abandoned') ORDER BY m.id;
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT m.id, 'audit', json_object('entry_kind', 'upgrade_rehandin_hint', 'from_status', m.from_state, 'to_status', m.to_state,
         'reason', '[Engine hint: this task was marked finished before the upgrade. Hand it in again with proof items so it can be checked.]',
         'action_taken', NULL, 'note', NULL, 'evidence_json', NULL), 'migration-901', n.ms
  FROM _td_map m, _td_now n WHERE m.rehandin ORDER BY m.id;
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT m.id, 'user_verdict_cleared', json_object('reason', 'upgrade: the request is answered by the one path to done'), 'migration-901', n.ms
  FROM _td_map m, _td_now n WHERE m.clear_verdict ORDER BY m.id;
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT m.id, 'override_resolved', json_object('reason', 'upgrade: the request is answered by the one path to done'), 'migration-901', n.ms
  FROM _td_map m, _td_now n WHERE m.clear_override ORDER BY m.id;

-- 7. Triggers: a delivery that is a done row's evidence stays; board work reaches done or failed only
--    on an upheld decision for that outcome (the owner's own decisions write one too).
CREATE TRIGGER deliveries_done_evidence_no_delete
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

CREATE TRIGGER board_done_needs_decision
BEFORE UPDATE OF state ON work
WHEN NEW.state IN ('done','failed')
 AND OLD.state <> NEW.state
 AND NEW.kind IN ('task','project')
 AND NEW.root_kind <> 'a2a_thread'
BEGIN
  SELECT RAISE(ABORT, 'board work reaches done or failed only on an upheld decision')
  WHERE NOT EXISTS (
    SELECT 1 FROM adjudications adj
     WHERE adj.work_id = NEW.id
       AND adj.claim_state = NEW.state
       AND adj.verdict = 'upheld'
  );
END;

-- 8. Settings: the sensei agents are always on, and the Healer's quietest mode is monitor.
DELETE FROM config WHERE key IN ('pm_agent_enabled','trainer_agent_enabled','trainer_enabled','imaginer_enabled','dreamer_enabled','healer_enabled');
UPDATE config SET value = 'monitor', updated_at = datetime('now') WHERE key = 'healer_mode' AND value = 'off';

-- 9. A file's link to the delivery that carried it had no reader.
ALTER TABLE turn_artifacts DROP COLUMN delivery_id;

-- 10. The decision model's shadow log, switch records, pinned modes, learned pace and density, and its check versions had no reader.
DROP TABLE IF EXISTS decision_shadow;
DELETE FROM config WHERE key LIKE 'decision_switch.%' OR key LIKE 'decision_mode.%' OR key LIKE 'decide_pace.%' OR key LIKE 'token_density.%';
DELETE FROM healer_state WHERE scope IN ('summary_check_version', 'summary_check_kept');

-- 11. Assertions: any false one aborts the whole file. The board states, closed_at pairing and a done
--     row's delivery are the CHECKs on work, which refuse a bad row as it is copied.
CREATE TEMP TABLE _td_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _td_assert (name, ok) VALUES
  ('every_scoped_row_mapped_once',
   (SELECT COUNT(*) FROM _td_map) = (SELECT COUNT(*) FROM work WHERE kind IN ('task','project') AND root_kind IN ('legacy','tracker','engine_scaffold'))),
  ('history_keeps_its_state',
   (SELECT COUNT(*) FROM _td_map m JOIN work w ON w.id = m.id WHERE m.from_state IN ('done','failed','abandoned') AND w.state <> m.from_state) = 0),
  ('other_rows_keep_their_states',
   (SELECT COUNT(*) FROM (SELECT state, COUNT(*) AS n FROM work WHERE NOT EXISTS (SELECT 1 FROM _td_map m WHERE m.id = work.id) GROUP BY state
      EXCEPT SELECT state, n FROM _td_rest)) = 0
   AND (SELECT COUNT(*) FROM work WHERE NOT EXISTS (SELECT 1 FROM _td_map m WHERE m.id = work.id)) = (SELECT COALESCE(SUM(n), 0) FROM _td_rest)),
  ('every_rehandin_has_its_hint',
   (SELECT COUNT(*) FROM _td_map m WHERE m.rehandin AND (SELECT COUNT(*) FROM work_events e WHERE e.work_id = m.id
      AND e.kind = 'audit' AND json_extract(e.payload, '$.entry_kind') = 'upgrade_rehandin_hint') <> 1) = 0),
  ('no_wake_column_moved',
   (SELECT COUNT(*) FROM _td_wake p JOIN work w ON w.id = p.id LEFT JOIN _td_map m ON m.id = p.id
     WHERE w.wakes IS NOT p.wakes OR w.ttl_at IS NOT p.ttl_at OR w.next_attempt_at IS NOT p.next_attempt_at
        OR w.next_run_at IS NOT p.next_run_at
        OR (COALESCE(m.pause_schedule, 0) = 0 AND (w.is_paused IS NOT p.is_paused OR w.schedule_status IS NOT p.schedule_status))) = 0
   AND (SELECT COUNT(*) FROM work) = (SELECT COUNT(*) FROM _td_wake)),
  ('nothing_sent',
   (SELECT deliveries FROM _td_counts) = (SELECT COUNT(*) FROM deliveries) AND (SELECT messages FROM _td_counts) = (SELECT COUNT(*) FROM messages)),
  ('events_only_appended',
   (SELECT COUNT(*) FROM work_events WHERE id <= (SELECT max_event FROM _td_counts)) = (SELECT events FROM _td_counts)
   AND (SELECT COUNT(*) FROM work_events WHERE actor = 'migration-901') = (SELECT COUNT(*) FROM work_events) - (SELECT events FROM _td_counts)),
  ('adjudications_intact', (SELECT adjudications FROM _td_counts) = (SELECT COUNT(*) FROM adjudications)),
  ('census_after_equals_before',
   (SELECT COUNT(*) FROM (SELECT class, n FROM _td_before EXCEPT
      SELECT m.class, COUNT(*) FROM _td_map m JOIN work w ON w.id = m.id AND w.state = m.to_state AND w.hold_kind IS m.hold_kind GROUP BY m.class)) = 0);

-- 12. The report, read once by the boot log.
INSERT INTO config (key, value) VALUES ('task_done_upgrade_last', json_object(
  'at', (SELECT ms FROM _td_now),
  'classes', (SELECT json_group_object(class, n) FROM _td_before),
  'orphan_events', (SELECT COUNT(*) FROM work_events e WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = e.work_id))))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');

DROP TABLE _td_assert;
DROP TABLE _td_counts;
DROP TABLE _td_rest;
DROP TABLE _td_wake;
DROP TABLE _td_before;
DROP TABLE _td_map;
DROP TABLE _td_facts;
DROP TABLE _td_ev;
DROP TABLE _td_now;
