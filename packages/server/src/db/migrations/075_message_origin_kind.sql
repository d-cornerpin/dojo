-- Structured engine-origin for messages (message-attribution redesign, write side).
--
-- Engine events (tracker assignments, scheduler fires, healer notices, thrash
-- gates, response nudges, update checks, continuity briefs) were persisted as
-- role='user' with attribution living ONLY in a [SOURCE: …] / [Engine …] /
-- [System: …] text marker. The engine then had to re-parse that prose to know
-- the message was an engine event and not the user talking (deriveOrigin's
-- read-shim). That is the exact "events masquerade as the user" disease this
-- redesign removes: a new event type whose marker the shim doesn't recognize
-- would leak into the live conversation as a peer user message.
--
-- These columns carry the attribution STRUCTURALLY so deriveOrigin can read it
-- directly instead of parsing prose:
--   origin_kind   — 'engine' (extensible to other kinds later). NULL for normal
--                   user/agent/self rows (those resolve from role + the existing
--                   structured columns: inbound_meta for channels, a2a_* for A2A).
--   origin_intent — coarse event type ('tracker' | 'scheduler' | 'healer' |
--                   'thrash_gate' | 'response_nudge' | 'update' | 'continuity' |
--                   'hint' | 'engine' | 'system'), used for the EVENTS-lane label.
-- The human-readable [SOURCE: …] prose stays in `content` (the agent still reads
-- it); these columns are what the engine/dashboard attribute off.
ALTER TABLE messages ADD COLUMN origin_kind TEXT DEFAULT NULL;
ALTER TABLE messages ADD COLUMN origin_intent TEXT DEFAULT NULL;

-- Backfill existing engine rows so the read-shim is no longer load-bearing for
-- history either. Strictly scoped: role='user' engine prose markers ONLY, and
-- explicitly NOT channel inbound (inbound_meta present) nor A2A (a2a_thread_id /
-- source='a2a'). The marker set is the exact engine prefixes observed in the DB;
-- channel ([SOURCE: GMAIL|IMESSAGE|TEAMS|PHONE|OUTLOOK|SMS …]) and A2A
-- ([A2A: …], [SOURCE: AGENT MESSAGE …], [SOURCE: PM AGENT POKE …]) prefixes are
-- deliberately excluded.
UPDATE messages
SET origin_kind = 'engine',
    origin_intent = CASE
      WHEN content LIKE '[SOURCE: TRACKER%'      THEN 'tracker'
      WHEN content LIKE '[SOURCE: SCHEDULER%'    THEN 'scheduler'
      WHEN content LIKE '[SOURCE: HEALER%'       THEN 'healer'
      WHEN content LIKE '[SOURCE: SUB-AGENT%'    THEN 'subagent'
      WHEN content LIKE '[SOURCE: DOJO UPDATE%'  THEN 'update'
      WHEN content LIKE '[SOURCE: ENGINE%'       THEN 'engine'
      WHEN content LIKE '[Engine thrash gate%'   THEN 'thrash_gate'
      WHEN content LIKE '[Engine hint:%'         THEN 'hint'
      WHEN content LIKE '[Engine note:%'         THEN 'note'
      WHEN content LIKE '[System note:%'         THEN 'system_note'
      WHEN content LIKE '[CONTINUITY BRIEF%'     THEN 'continuity'
      WHEN content LIKE '[Context note%'         THEN 'context_note'
      WHEN content LIKE '[System:%'              THEN 'system'
      WHEN content LIKE '[SYSTEM%'               THEN 'system'
      ELSE 'engine'
    END
WHERE role = 'user'
  AND origin_kind IS NULL
  AND a2a_thread_id IS NULL
  AND inbound_meta IS NULL
  AND (source IS NULL OR source <> 'a2a')
  AND (
       content LIKE '[SOURCE: TRACKER%'
    OR content LIKE '[SOURCE: SCHEDULER%'
    OR content LIKE '[SOURCE: HEALER%'
    OR content LIKE '[SOURCE: SUB-AGENT%'
    OR content LIKE '[SOURCE: DOJO UPDATE%'
    OR content LIKE '[SOURCE: ENGINE%'
    OR content LIKE '[Engine thrash gate%'
    OR content LIKE '[Engine hint:%'
    OR content LIKE '[Engine note:%'
    OR content LIKE '[System note:%'
    OR content LIKE '[CONTINUITY BRIEF%'
    OR content LIKE '[Context note%'
    OR content LIKE '[System:%'
    OR content LIKE '[SYSTEM%'
  );
