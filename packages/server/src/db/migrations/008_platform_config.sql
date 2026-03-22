-- ═══════════════════════════════════════════════════════════════════════════════
-- Platform Configuration: configurable agent names and platform identity
-- ═══════════════════════════════════════════════════════════════════════════════

-- Platform config stored in the existing config table as key-value pairs.
-- Keys:
--   platform_name          — "DOJO Agent Platform"
--   owner_name             — User's name (set during OOBE)
--   primary_agent_name     — Primary agent's display name (set during OOBE)
--   primary_agent_id       — Primary agent's ID in agents table (set during OOBE)
--   pm_agent_name          — Project manager's display name (set during OOBE)
--   pm_agent_id            — PM agent's ID in agents table (set during OOBE)
--   pm_agent_enabled       — "true" or "false"
--   setup_completed        — "true" or "false"

-- Seed defaults (OOBE will overwrite these with user's choices)
INSERT OR IGNORE INTO config (key, value) VALUES ('platform_name', 'DOJO Agent Platform');
INSERT OR IGNORE INTO config (key, value) VALUES ('primary_agent_id', 'primary');
INSERT OR IGNORE INTO config (key, value) VALUES ('primary_agent_name', 'Agent');
INSERT OR IGNORE INTO config (key, value) VALUES ('pm_agent_id', 'pm');
INSERT OR IGNORE INTO config (key, value) VALUES ('pm_agent_name', 'PM');
INSERT OR IGNORE INTO config (key, value) VALUES ('pm_agent_enabled', 'true');
