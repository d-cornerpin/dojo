-- Persist the healer recovery-attempt counter so it survives server
-- restarts and can be inspected/reset. Pre-2026-04-29 this lived only
-- in an in-memory Map, which meant a long-running server could silently
-- accumulate attempts past MAX_RECOVERY_ATTEMPTS and the healer would
-- be permanently suppressed for that agent until the counter was reset
-- by a recovery — but recoveries themselves only happened if the user
-- manually unstuck the agent.

ALTER TABLE agents ADD COLUMN recovery_attempts INTEGER DEFAULT 0;
