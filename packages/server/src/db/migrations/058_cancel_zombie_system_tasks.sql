-- v2.9.22 — One-time cleanup of zombie tasks assigned to system agents
-- (PM / Healer / Dreamer).
--
-- Pre-fix, send_to_agent(intent='ASSIGN') auto-created a tracker row
-- assigned to whoever the receiver was, including PM. The dashboard
-- hides PM/Healer/Dreamer tasks by default (they're platform mechanics
-- the user shouldn't see in their kanban). So tasks assigned to a
-- system agent became invisible to the user, but kept firing the PM
-- validation loops on every PM tick:
--
--   engine auto-pauses idle in_progress task
--      -> PM detects UNVALIDATED_PAUSE
--      -> PM rejects pause as "empty reason" (PM was reading the wrong
--         task_log entry_kind so the actual reason was hidden)
--      -> task reverts to in_progress
--      -> agent goes idle on it, can't act
--      -> engine auto-pauses again
--      -> loop, no user surface to clear it
--
-- The autoCreateAssignTask path is now gated on receiver-is-not-a-
-- system-agent, so no new tasks land here. This migration sweeps the
-- existing zombies into 'fallen' so they stop driving PM cycles and
-- show up in the Fallen column on first dashboard load after deploy.
--
-- 'fallen' (not 'complete') because the work was never actually done —
-- these were artifacts of a routing bug, not user-acknowledged work.
-- Idempotent: re-running has no effect after the first pass.

UPDATE tasks
SET status = 'fallen',
    is_paused = 0,
    notes = COALESCE(notes, '') || char(10) ||
            '[v2.9.22 startup cleanup: auto-failed because this task was assigned to a system agent (PM/Healer/Dreamer). System agents do not own user-facing work tasks. The send_to_agent ASSIGN flow that auto-created this row has been fixed at the engine layer.]' ||
            char(10),
    updated_at = datetime('now')
WHERE status IN ('in_progress', 'paused', 'on_deck', 'blocked')
  AND (
    assigned_to IN (
      SELECT value FROM config
      WHERE key IN ('pm_agent_id', 'healer_agent_id', 'dreamer_agent_id')
        AND value IS NOT NULL AND value != ''
    )
    OR assigned_to IN (
      SELECT id FROM agents WHERE name IN ('Dreamer', 'Healer')
    )
  );
