-- 124: ticket stamps (owner design 2026-07-22: the engine stamps the receipt
-- ticket with observed state along the way; the model reads the stamps
-- everywhere it meets the ticket, so it never guesses what has been done).
--
-- HARD RULES enforced by conformance locks: stamp writers never touch
-- updated_at (the drive ladder's idle clock), never touch status, and never
-- touch the validation key columns.
ALTER TABLE tasks ADD COLUMN last_activity_turn INTEGER;
ALTER TABLE tasks ADD COLUMN last_activity_at TEXT;
ALTER TABLE tasks ADD COLUMN last_activity_outcome TEXT;
ALTER TABLE tasks ADD COLUMN last_answered_turn INTEGER;
ALTER TABLE tasks ADD COLUMN last_answered_at TEXT;
ALTER TABLE tasks ADD COLUMN last_answer_message_id TEXT;
ALTER TABLE tasks ADD COLUMN last_delivery_at TEXT;
ALTER TABLE tasks ADD COLUMN last_delivery_summary TEXT;
