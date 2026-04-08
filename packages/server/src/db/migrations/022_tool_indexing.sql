-- Add always_loaded_tools column for the tool indexing system.
-- Stores a JSON array of tool names that should always be fully loaded
-- in the API tools parameter (bypassing the load_tool_docs lookup).
ALTER TABLE agents ADD COLUMN always_loaded_tools TEXT DEFAULT NULL;
