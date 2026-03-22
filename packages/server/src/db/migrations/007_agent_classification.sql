-- ═══════════════════════════════════════════════════════════════════════════════
-- Agent Classification: permanent, freelance, temp
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE agents ADD COLUMN classification TEXT NOT NULL DEFAULT 'apprentice';

-- Primary and PM agents are set to permanent during OOBE/agent creation, not here.
-- This migration only adds the column. Classification is applied when agents are created.
