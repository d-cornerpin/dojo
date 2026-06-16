-- Cross-turn record of FAILING tool calls by canonical signature.
-- Within-turn circling is caught by the in-memory loop detector, but that
-- state dies with the turn, so "tries the same broken thing once per wakeup,
-- forever" was invisible. Only failures are recorded: an identical SUCCEEDING
-- call across turns is routine (daily email checks), not circling, and a
-- success clears the row.
CREATE TABLE IF NOT EXISTS agent_tool_failures (
  agent_id   TEXT NOT NULL,
  signature  TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  hit_count  INTEGER NOT NULL DEFAULT 1,
  first_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, signature)
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_failures_last
  ON agent_tool_failures (agent_id, last_at);
