-- Session boundary: allows agents to start fresh sessions
-- without losing message history. Old messages stay in DB
-- but are excluded from context assembly.
ALTER TABLE agents ADD COLUMN session_started_at TEXT DEFAULT NULL;
