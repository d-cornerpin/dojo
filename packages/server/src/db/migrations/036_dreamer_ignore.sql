-- Per-agent and per-group "Dreamer ignore" flag.
--
-- When set on an agent, that agent's conversations are NOT archived to
-- vault_conversations when the agent terminates or compacts — so the
-- Dreamer never sees them and never extracts vault entries from them.
-- Use this for ephemeral test agents, junk-prone sub-agents, or any
-- group whose chatter would just clog the nightly Dreamer cycle without
-- producing useful long-term memory.
--
-- A group-level flag covers every member of the group transitively:
-- on archive, archive.ts checks both the agent's own flag AND the
-- group's flag.

ALTER TABLE agents ADD COLUMN dreamer_ignore INTEGER DEFAULT 0;
ALTER TABLE agent_groups ADD COLUMN dreamer_ignore INTEGER DEFAULT 0;
