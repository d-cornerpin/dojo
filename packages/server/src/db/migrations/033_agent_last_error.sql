-- Store the last error that caused an agent to enter 'error' status.
-- Used by the injury recovery system to diagnose and attempt auto-recovery.

ALTER TABLE agents ADD COLUMN last_error TEXT;
ALTER TABLE agents ADD COLUMN last_error_at TEXT;
