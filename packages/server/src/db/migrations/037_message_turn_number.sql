-- Phase 0 migration for v2 runtime stub-and-store (Part XVIII §E).
--
-- Records which turn each message belongs to so the assembler can replace
-- raw tool results older than N turns with stubs. NULL on pre-cutover rows
-- is treated as "very old" — those results get stubbed on first v2 read,
-- which is intentional (pre-cutover context was bloated under v1 patterns).

ALTER TABLE messages ADD COLUMN turn_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_messages_agent_turn ON messages(agent_id, turn_number);
