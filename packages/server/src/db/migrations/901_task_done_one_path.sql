-- 901: ONE PATH TO DONE, the release's one migration (Step 2b writes part A; Step 2f completes this file).
-- Numbered after 900 because 900 reads `work` and `adjudications` as the stable bridge left them.
-- Part A, and nothing else:
--   work_events.kind gains handed_in, hand_in_refused, decided, proof_opened (work/event-kinds.ts
--   carries the same list; the conformance test diffs the two);
--   work.state gains handed_in (waiting for a decision) and sent_back (the worker continues);
--   work gains the hold: hold_kind (NULL, 'paused' or 'blocked'), hold_reason and hold_at. A held task
--   keeps its state (work/done/hold.ts). 'blocked' stays legal in the state CHECK for chat asks.
-- SQLite has no ADD CONSTRAINT, so both tables are rebuilt. `work` is rebuilt ONCE in this release:
-- 2f edits this same CREATE to drop the dead columns. The rebuild drops every trigger and index on
-- `work`, and the deliveries trigger that names it (a RENAME re-parses it), and re-creates them.

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

DROP TRIGGER IF EXISTS deliveries_done_evidence_no_delete;
DROP TRIGGER IF EXISTS two_key_completion;

CREATE TABLE work_new (
  id TEXT PRIMARY KEY,                    -- task ids carry over: one ID space (OR1)
  kind TEXT NOT NULL CHECK (kind IN ('ask','task','project','occurrence','commitment')),
  parent_id TEXT REFERENCES work(id),
  -- NO FK, NO CASCADE on agent_id, see PART 0 rider 1. This is the whole rider.
  agent_id TEXT NOT NULL, assignee_agent TEXT,
  requester TEXT NOT NULL CHECK (requester IN ('owner','agent','schedule','watcher')),
  requester_id TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  root_kind TEXT NOT NULL, root_id TEXT NOT NULL,   -- origin REQUIRED (may be 'legacy')
  state TEXT NOT NULL CHECK (state IN ('open','claimed','handed_in','sent_back','done','failed','abandoned','paused','blocked','on_deck')),
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
  provenance TEXT NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','migrated','rescued')), description TEXT, original_description TEXT, completion_summary TEXT, result TEXT, evidence_json TEXT, step_number INTEGER, total_steps INTEGER, phase INTEGER, depends_on TEXT, assigned_to_group TEXT, task_kind TEXT, level INTEGER, phase_count INTEGER, current_phase INTEGER, group_id TEXT, source_message_id TEXT, origin_turn INTEGER, origin_conv_key TEXT, origin_kind TEXT, a2a_thread_id TEXT, last_smell_flag TEXT, scheduled_start INTEGER, repeat_interval INTEGER, repeat_unit TEXT, repeat_end_type TEXT, repeat_end_value TEXT, repeat_days_of_week TEXT, schedule_status TEXT, is_paused INTEGER NOT NULL DEFAULT 0, paused_until INTEGER, status_before_pause TEXT, last_run_at INTEGER, missed_runs_paused_at INTEGER, last_activity_turn INTEGER, last_activity_at INTEGER, last_activity_outcome TEXT, last_answered_turn INTEGER, last_answered_at INTEGER, last_delivery_summary TEXT, effort_calls INTEGER NOT NULL DEFAULT 0, effort_reviewed_calls INTEGER NOT NULL DEFAULT 0, measure_json TEXT, measure_initial INTEGER, measure_remaining INTEGER, measure_at INTEGER, plan_json TEXT,
  hold_kind TEXT CHECK (hold_kind IN ('paused','blocked')), hold_reason TEXT, hold_at INTEGER,
  CHECK ((state IN ('done','failed','abandoned')) = (closed_at IS NOT NULL)),
  CHECK (state <> 'done' OR result_delivery_id IS NOT NULL),   -- done means DELIVERED
  CHECK (kind <> 'project' OR parent_id IS NULL)
);
INSERT INTO work_new SELECT *, NULL, NULL, NULL FROM work;
DROP TABLE work;
ALTER TABLE work_new RENAME TO work;

CREATE INDEX ix_work_children_order ON work(parent_id, step_number) WHERE kind = 'task';
CREATE INDEX ix_work_due ON work(schedule_status, is_paused, next_run_at) WHERE schedule_status IS NOT NULL;
CREATE INDEX ix_work_queue ON work(agent_id, state, kind);
CREATE INDEX ix_work_root ON work(root_kind, root_id);
CREATE UNIQUE INDEX ux_work_occurrence ON work(parent_id, sequence) WHERE kind='occurrence';

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
