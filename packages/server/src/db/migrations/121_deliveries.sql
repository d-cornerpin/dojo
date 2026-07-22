-- 121: first-class outbound deliveries (lanes & lineage P6b-2).
--
-- Every reply the engine or a send tool pushes onto a channel becomes a ROW
-- carrying who/where/why/how-it-went, keyed to the turn and the RECIPIENT's
-- conversation. Until now the only record was a prose "[Reply routed via X]"
-- system marker plus scattered echo heuristics; every reader (RECENT
-- OUTBOUND, cross-conv echo, download-link backstop, grounding guards)
-- re-derived delivery facts from prose and clocks. The marker survives as
-- user-visible chat transparency; the load-bearing reads move here.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  turn_number INTEGER,
  tool TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_id TEXT,
  recipient_display TEXT,
  conversation_id TEXT,
  root_kind TEXT,
  root_id TEXT,
  message_id TEXT,
  receipt_id TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_turn ON deliveries(agent_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_deliveries_conversation ON deliveries(conversation_id) WHERE conversation_id IS NOT NULL;

-- Turn artifacts: files/links produced during a turn awaiting (or having
-- completed) delivery to the user. Replaces the in-memory pending-attachments
-- buffer complex; the drains become reads of undelivered rows.
CREATE TABLE IF NOT EXISTS turn_artifacts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  turn_number INTEGER,
  kind TEXT NOT NULL,
  path TEXT,
  caption TEXT,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  delivery_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_artifacts_pending ON turn_artifacts(agent_id) WHERE delivered_at IS NULL;
