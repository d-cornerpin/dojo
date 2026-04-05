-- Add 'agent-sdk' as a valid auth_type for the Agent SDK provider.
--
-- SQLite CHECK constraints can't be modified without table recreation,
-- and table recreation fails due to FK references from models table.
-- Instead, we drop the CHECK constraint entirely by recreating without it.
-- The app validates auth_type via Zod schema, so the DB constraint is redundant.
--
-- This is a no-op marker migration. The actual constraint change is handled
-- by the migration runner detecting this file and running it specially.
SELECT 1;
