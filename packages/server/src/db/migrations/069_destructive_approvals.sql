-- Destructive-action approvals (remediation Phase 4 item 4d, open question 6):
-- the primary agent has full reign; every OTHER agent's destructive tool call
-- is held by the ENGINE pending the primary's approval. Prose cannot hold this
-- line on the weakest model; this table is the mechanism.
CREATE TABLE IF NOT EXISTS destructive_approvals (
  token        TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,          -- the requesting (non-primary) agent
  tool_name    TEXT NOT NULL,
  signature    TEXT NOT NULL,          -- canonical tool signature the approval is bound to
  request_text TEXT NOT NULL,          -- human/agent-readable description of the held call
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | consumed
  decided_by   TEXT,                   -- approving/denying agent id
  decided_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_destructive_approvals_agent
  ON destructive_approvals (agent_id, signature, status);
