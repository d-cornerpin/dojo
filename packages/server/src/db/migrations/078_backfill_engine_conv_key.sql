-- C7: backfill conv_key for historical engine rows so a deploy/restart can't replay them.
--
-- Migration 076 added conv_key but did NOT backfill it, so every pre-076 engine row
-- (scheduler/reminder/tracker/healer notices, origin_kind='engine') still has conv_key
-- NULL. getPendingEngineEvent selects conv_key-NULL engine rows as "unprocessed events
-- that still need a turn" — so after a deploy the agent's whole history of old engine
-- rows looked pending and replayed as a burst of engine turns (thrash + stale actions).
--
-- Stamp every engine row older than 2 minutes as processed ('engine' = the same sentinel
-- the loop writes at pickup). The 2-minute window intentionally leaves a genuinely-recent
-- engine event (one that fired just before the restart) unstamped, so it still gets its
-- turn; anything older is treated as already-handled history. New engine rows after this
-- migration are stamped at pickup by the loop as usual. Runs once, like all migrations.
UPDATE messages
   SET conv_key = 'engine'
 WHERE origin_kind = 'engine'
   AND conv_key IS NULL
   AND created_at < datetime('now', '-2 minutes');
