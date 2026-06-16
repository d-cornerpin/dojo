-- Healer damping state, durable across restarts (remediation Phase 4, S8.3):
-- the in-memory maps reset on a process bounce, so a crash-loop that survived
-- a restart was re-hammered by the very backoff meant to damp it, and a
-- provider-wide outage alert forgot it had already fired.
CREATE TABLE IF NOT EXISTS healer_state (
  scope      TEXT NOT NULL,   -- 'agent_suppression' (suppressed-until) | 'provider_alert' (alerted-at)
  key        TEXT NOT NULL,   -- agent id | provider name
  at_ms      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key)
);
