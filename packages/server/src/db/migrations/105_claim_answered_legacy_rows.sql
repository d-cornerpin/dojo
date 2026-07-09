-- 105: fleet-upgrade duplicate-reply guard. Claim (mark swept) the pre-076
-- user rows that were ALREADY answered before the box updated, so the first boot
-- after the upgrade does not re-serve them and text a duplicate reply on a real
-- channel.
--
-- THE HAZARD (upgrade-boot duplicate replies): rows written before migration 076
-- carry conv_key NULL. getWaitingHumanConversations (agent/v2/counterparty.ts)
-- treats every unclaimed (conv_key IS NULL, swept_at IS NULL) authorized-human
-- user row as a WAITING conversation the agent still owes a reply to. The boot
-- staleness sweep only suppresses rows older than its 30-minute window, so a user
-- who was chatting within the 30 minutes just before updating has those recent
-- messages RE-SERVED after the upgrade boot -> the agent replies AGAIN to messages
-- it already answered, on iMessage / SMS / email / Teams. Pre-076 history is deep
-- (this is exactly the 3.1.9 -> tip path), so the exposed set is large.
--
-- THE FIX (conservative already-answered heuristic): stamp swept_at (the migration
-- 082 drain-suppression column, the sweep's OWN mechanism, which preserves the
-- row's true identity for recall, unlike overwriting conv_key) on a legacy user
-- row ONLY when there is direct evidence it was already answered: a later
-- assistant REPLY exists for the same agent within 30 minutes after it. "Reply"
-- means a natural-language assistant row (content NOT LIKE '[{%', which excludes
-- structured tool_use content-block arrays that are mid-task steps, not a delivered
-- answer). A genuinely unanswered FINAL message (no assistant reply after it) is
-- left UNSWEPT on purpose, so it is served exactly ONCE after the upgrade, which is
-- the correct behavior, the agent should answer a still-open ask.
--
-- SCOPE + SAFETY:
--   * role='user' only, conv_key IS NULL (never claimed by a turn), swept_at IS
--     NULL (not already suppressed), retired_at IS NULL (do not touch the
--     migration 102 / 104 relocated-and-retired inter-agent rows).
--   * created_at <= now-2min: an in-flight ask that lands DURING the upgrade boot
--     is younger than 2 minutes and is therefore NOT claimed here, so a real
--     just-arrived question is never falsely suppressed.
--   * Idempotent by construction: it only sets swept_at where it is NULL and never
--     clears it, so a re-run (the runner reapplies a rolled-back migration whole)
--     finds nothing left to do and the heuristic is deterministic.
--
-- Sorts AFTER 104 (the 105 numeric prefix), so it runs on the fully-relocated
-- store, and the retired_at IS NULL guard keeps it off the rows 104 just retired.

UPDATE messages
   SET swept_at = datetime('now')
 WHERE role = 'user'
   AND conv_key IS NULL
   AND swept_at IS NULL
   AND retired_at IS NULL
   AND datetime(created_at) <= datetime('now', '-2 minutes')
   AND EXISTS (
        SELECT 1
          FROM messages a
         WHERE a.agent_id = messages.agent_id
           AND a.role = 'assistant'
           AND datetime(a.created_at) >= datetime(messages.created_at)
           AND datetime(a.created_at) <= datetime(messages.created_at, '+30 minutes')
           AND a.content NOT LIKE '[{%'
   );
