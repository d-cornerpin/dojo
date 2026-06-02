-- Phase B.1: explicit override-request queue.
--
-- When an agent's submission hits the engine hard gate and the agent
-- believes the engine is wrong, or when the hard-gate circuit-breaker
-- auto-fires after 3 consecutive same-task rejections, a row lands
-- here. PM resolves it via tracker_override(approve, reason); a 12h
-- auto-expire sweep flips stale requests to 'denied' with a notice
-- to the agent.

CREATE TABLE IF NOT EXISTS task_override_requests (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by        TEXT NOT NULL,         -- agent id (or 'engine' for circuit-breaker)
  requested_status    TEXT NOT NULL,         -- the status the agent wants to land in
  justification       TEXT NOT NULL,
  last_engine_error   TEXT,                  -- the engine's last rejection reason
  attempts_attached   INTEGER NOT NULL DEFAULT 1,  -- the circuit-breaker bumps this past 1
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'approved', 'denied', 'auto_denied')),
  resolved_by         TEXT,
  resolved_reason     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_override_requests_status ON task_override_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_override_requests_task ON task_override_requests(task_id, status);

-- Per-(agent, task) rate limit: at most one pending request at a time.
-- A second tracker_request_override while one is still pending returns
-- an error referencing the prior request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_override_requests_one_pending_per_agent_task
  ON task_override_requests(task_id, requested_by)
  WHERE status = 'pending';
