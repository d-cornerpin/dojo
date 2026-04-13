-- Terminate any stuck first-run bootstrap Dreamer agents.
-- The bootstrap Dreamer was incorrectly spawned with classification='sensei'
-- and groupId='system-group', causing it to appear as a second permanent
-- Dreamer in the Masters box if it never called complete_task.
-- These are identifiable as: name='Dreamer', agent_type != 'persistent',
-- id != the permanent dreamer ID stored in config.
UPDATE agents
SET status = 'terminated',
    updated_at = datetime('now')
WHERE name = 'Dreamer'
  AND agent_type != 'persistent'
  AND id != COALESCE(
    (SELECT value FROM config WHERE key = 'dreamer_agent_id'),
    'dreamer'
  )
  AND status != 'terminated';
