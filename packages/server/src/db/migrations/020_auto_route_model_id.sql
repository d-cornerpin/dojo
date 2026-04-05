-- Add a sentinel row in models table so model_id = 'auto' passes FK checks.
-- This is a virtual model — the router selects the real model at call time.
INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
VALUES ('auto', '__system__', 'Auto (Smart Router)', 'auto', '[]', 200000, 64000, 0, 0, 1, datetime('now'), datetime('now'));

-- We also need a dummy provider for the FK on provider_id
INSERT OR IGNORE INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
VALUES ('__system__', 'System', 'anthropic', NULL, 'none', 1, datetime('now'), datetime('now'));

-- Migrate agents using config.autoRouted flag to model_id = 'auto'.
UPDATE agents SET model_id = 'auto'
WHERE model_id IS NULL
  AND json_extract(config, '$.autoRouted') = 1;
