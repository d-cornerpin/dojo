-- Make Healer and Dreamer permanent resident agents with fixed IDs and config keys.

INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('healer_agent_id', 'healer', datetime('now'));
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('healer_agent_name', 'Healer', datetime('now'));
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('dreamer_agent_id', 'dreamer', datetime('now'));
INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('dreamer_agent_name', 'Dreamer', datetime('now'));
