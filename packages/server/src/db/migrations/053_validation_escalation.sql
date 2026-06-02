-- 2026-06-02: validation-escalation tracking.
--
-- When a task is marked complete/paused/blocked but PM hasn't validated
-- within 5 minutes, the engine asks the user (via chat + iMessage when
-- away). This column records when that ask was sent so we don't nag
-- repeatedly. NULL = no escalation sent yet. Once the user (or PM)
-- validates, the *_validated flag flips, the bug icon disappears, and
-- this column stays as audit history.

ALTER TABLE tasks ADD COLUMN validation_escalated_at TEXT;

-- thread id the engine used to ask the user; lets us route the user's
-- reply back to the assigned agent for processing.
ALTER TABLE tasks ADD COLUMN validation_thread_id TEXT;
