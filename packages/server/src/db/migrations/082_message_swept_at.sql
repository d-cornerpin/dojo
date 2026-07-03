-- 082: D11, stop hiding the user's own messages behind a fake conv_key.
--
-- The boot staleness sweep (index.ts) stamped conv_key = 'stale-boot' on every
-- stale unanswered user row so a restart couldn't re-run weeks-old backlog. But
-- overwriting conv_key DESTROYS the row's conversation identity: recall
-- (recall.ts) scopes to `conv_key = <turn> OR (conv_key IS NULL AND role IN
-- ('assistant','tool'))`, and a 'stale-boot' user row matches neither, so
-- recall returned the agent's own replies but not what the USER said. On this DB
-- ~3,408 primary user rows were stamped this way.
--
-- Fix: use a dedicated drain-suppression column `swept_at` instead. The boot
-- sweep and the waiting/engine-drain queries respect it (a swept row can't
-- re-wake an agent), while conv_key keeps the row's true derived identity so
-- recall and scoping still find the user's message.
--
-- Also RESTORE the rows the old sweep already damaged: put conv_key back to NULL
-- (true identity re-derivable) and mark them swept (so they stay suppressed from
-- the drain, exactly as intended, they are genuinely old now).

ALTER TABLE messages ADD COLUMN swept_at TEXT;

UPDATE messages
   SET swept_at = created_at,
       conv_key = NULL
 WHERE conv_key = 'stale-boot';
