-- Add equipped_techniques column to agents table
-- JSON array of technique IDs that are auto-loaded into the agent's context
ALTER TABLE agents ADD COLUMN equipped_techniques TEXT DEFAULT '[]';
