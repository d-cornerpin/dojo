-- v2.10.3 — Retire the Imaginer agent.
--
-- Image generation is now a model capability not an agent role.
-- Settings → Dojo → Image Generation Model picks one image-capable
-- model, and the `image_create` tool calls it directly. No more
-- middleman Sensei agent that wrapped a single model call with its
-- own chat, status badge, A2A delivery, and prompt.
--
-- Cleanup:
--   1. Carry forward the legacy `imaginer_image_model` config value
--      into the new `dojo_image_gen_model_id` key, so users who
--      already picked a model in Settings → Dojo → Imaginer don't
--      have to re-pick.
--   2. Disable the Imaginer enablement flag.
--   3. Terminate the Imaginer agent row (status='terminated').
--      Existing message history is preserved — only the agent
--      stops being active. The agent row stays around as
--      'terminated' so historical chat/audit references still
--      resolve.
--
-- Idempotent: re-running has no effect after the first pass.

-- Step 1: carry the legacy image model into the new platform config key.
INSERT OR IGNORE INTO config (key, value, updated_at)
SELECT 'dojo_image_gen_model_id', value, datetime('now')
FROM config
WHERE key = 'imaginer_image_model'
  AND value IS NOT NULL
  AND value != ''
  AND NOT EXISTS (SELECT 1 FROM config WHERE key = 'dojo_image_gen_model_id');

-- Step 2: disable Imaginer enablement so any residual code paths that
-- check `isImaginerEnabled()` see false.
UPDATE config SET value = 'false', updated_at = datetime('now')
WHERE key = 'imaginer_enabled';

-- Step 3: terminate the Imaginer agent row(s). Uses the config-driven
-- ID plus a name match in case any historical rows had different IDs.
UPDATE agents
SET status = 'terminated',
    last_error = COALESCE(last_error, '') || char(10) || '[v2.10.3] Imaginer agent retired; image generation is now a platform-config model picker. See Settings → Dojo → Image Generation Model.',
    updated_at = datetime('now')
WHERE id IN (SELECT value FROM config WHERE key = 'imaginer_agent_id' AND value IS NOT NULL AND value != '')
   OR name = 'Imaginer';
