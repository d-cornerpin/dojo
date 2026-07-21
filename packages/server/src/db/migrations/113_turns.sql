-- 113: the turn record (lanes & lineage plan, phase 4).
--
-- The question nothing could answer until now, answered durably: what did
-- turn N serve, and how did it end. Until this table, "served" was inferred
-- backward from claim stamps on trigger rows, "answered" was guessed from
-- content adjacency and wording filters, and every consumer (close-out,
-- going-idle acks, re-answer guards, pokes) ran on clocks and prose.
--
-- outcome vocabulary: answered | no_reply | parked | handoff | aborted |
-- brake | error. answer_message_id = the persisted final reply row when
-- outcome='answered'.
CREATE TABLE IF NOT EXISTS turns (
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
  outcome TEXT,
  answer_message_id TEXT,
  PRIMARY KEY (agent_id, turn_number)
);
CREATE INDEX IF NOT EXISTS idx_turns_root ON turns(root_id) WHERE root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_turns_subject ON turns(agent_id, subject_id) WHERE subject_id IS NOT NULL;

-- Per-ask outcomes: every inbound ask row records WHICH turn served it and
-- WHICH reply answered it. The claim machinery already stamps conv_key at
-- pickup; these columns carry the forward links the drain, the acks, and the
-- audits read instead of timing/wording.
ALTER TABLE messages ADD COLUMN served_by_turn INTEGER;
ALTER TABLE messages ADD COLUMN answer_message_id TEXT;
ALTER TABLE inter_agent_messages ADD COLUMN served_by_turn INTEGER;
ALTER TABLE inter_agent_messages ADD COLUMN answer_message_id TEXT;
