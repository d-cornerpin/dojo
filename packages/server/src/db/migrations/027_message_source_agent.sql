-- Add source_agent_id column to messages for inter-agent message tracking.
-- When an agent sends a message to another agent via send_to_agent, the
-- source_agent_id is set to the sender's agent ID. This replaces regex
-- parsing of message content for auto-route reply detection.
ALTER TABLE messages ADD COLUMN source_agent_id TEXT DEFAULT NULL;
