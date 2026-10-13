-- 188 (t141): EVERY ROW THE AGENT WROTE SAYS WHAT IT BELONGS TO — the legacy rows labelled once.
--
-- ── WHAT WAS WRONG (tracker #12, the identity audit's RC1) ──
-- The agent's own rows (its text, its tool calls, its tool results) were labelled with their
-- conversation LATE — at turn end — and only when the turn had served a person. Every row
-- written on a turn that served no person (an email wake, an engine event, an agent-to-agent
-- thread) stayed `conversation_id IS NULL` for ever, and all three assembler scopers read NULL
-- as "this turn's own in-flight work, keep it". So an email wake's searches sat unlabelled
-- inside the owner's next dashboard conversation, reading as his task.
--
-- From this release a row is stamped AT INSERT (`memory/message-store.ts`), with the column
-- this file adds: `subject_kind`, what the row belongs to. This file gives the rows already on
-- the box the same label, ONCE, so nothing the agent can see is left unlabelled.
--
-- ── THE VOCABULARY (the CHECK below is the authority) ──
--   conv          the agent's own output in a PERSON's conversation (`conversation_id` names it)
--   a2a_thread    its output on an agent-to-agent thread (`a2a_thread_id` names it, when known)
--   engine_event  its output on an engine turn (a scheduled task, a reminder, a system event)
--   background    its output on a wake that served no conversation (a mailbox/channel notice)
--   legacy        a row from a person's turn that the old late stamp MISSED; its conversation
--                 is reconstructed below from the turn's own trigger. It is NOT `conv` on
--                 purpose: see "membership" below.
--   delivered     a result that reached a conversation AFTER the turn that asked for it — a
--                 delegated answer the engine relayed, an async media result. Written live only
--                 (by the relay and the media door); `root_id` names the request it answers.
--   unknown       nothing on the box says what it belonged to (no turn number, or no turn row)
-- Non-own rows (inbound, system, engine events) stay NULL here: they already carry their
-- identity in `lane`, `channel`, `sender_id`, `conversation_id` and `a2a_thread_id`, stamped
-- at ingest by their producers.
--
-- ── MEMBERSHIP DOES NOT MOVE (owner ruling OR-LABEL-NOT-HIDE; v3.3.3 plan, choice 2) ──
-- "No row visible today becomes invisible." The scopers now exclude an own row from another
-- conversation's live tail ONLY when it is positively `conv` for a different conversation —
-- which is exactly the set the old `conversation_id IS NOT NULL` excluded. Every row this file
-- labels was NULL yesterday and therefore KEPT; every label it writes is one of the kinds the
-- scopers keep (a2a_thread / engine_event / background / legacy / unknown). The one place that
-- matters is `legacy`: those rows gain a reconstructed `conversation_id`, and if they were
-- marked `conv` the reply guard would start dropping rows the agent can see today. They are
-- labelled with their real conversation and stay in view.
--
-- ── WHY TEMP TABLES (grown-fixture EXPLAIN, G13) ──
-- `messages.served_by_turn` has no index, so a correlated "which inbound did this turn serve"
-- subquery per own row is a scan per row — quadratic on a lived-in box. The per-turn facts are
-- computed ONCE below (one scan each) into indexed temp tables, and every UPDATE then reaches
-- them by key. The own-row predicate rides `ix_msg_turn (agent_id, turn_number)`.
--
-- ── SAFETY ──
-- Adds one nullable column; writes only that column plus `conversation_id` / `a2a_thread_id`
-- on rows where they are NULL; touches only role IN ('assistant','tool'); deletes nothing;
-- cannot RAISE (no JSON function, no parse; every written value is one of the CHECK's words or
-- an id copied from another row). IDEMPOTENT BY PREDICATE: every UPDATE requires
-- `subject_kind IS NULL` (or the id column NULL), so a second pass matches nothing.
-- Rehearsed per G13 on a VACUUM INTO copy of the dev DB and on an adversarial body — counts in
-- `overhaul-plans/t141-report.md` and `db/__tests__/t141-migration-188-labels-legacy-rows.test.ts`.

ALTER TABLE messages ADD COLUMN subject_kind TEXT
  CHECK (subject_kind IS NULL OR subject_kind IN
    ('conv', 'a2a_thread', 'engine_event', 'background', 'legacy', 'delivered', 'unknown'));

-- A thread is labelled by its FIRST peer row (a stable identity: a later poster never renames
-- the rows before it). This index makes that read a key lookup instead of an agent-wide scan.
CREATE INDEX IF NOT EXISTS ix_msg_a2a_thread_seq ON messages(a2a_thread_id, seq) WHERE a2a_thread_id IS NOT NULL;

-- (0) The per-turn facts, computed once. `trigger_conv` is the conversation of the row the
--     turn was born to serve; `served_conv` / `served_thread` are what it actually served.
CREATE TEMP TABLE t188_turn AS
SELECT t.agent_id, t.turn_number, t.subject_kind AS turn_kind,
       CASE WHEN t.subject_kind = 'a2a_thread' THEN t.subject_id END AS turn_thread,
       (SELECT m.conversation_id FROM messages m WHERE m.id = t.source_message_id) AS trigger_conv
  FROM turns t;
CREATE UNIQUE INDEX t188_turn_key ON t188_turn(agent_id, turn_number);

CREATE TEMP TABLE t188_served AS
SELECT agent_id, served_by_turn AS turn_number,
       MIN(CASE WHEN role = 'user' AND lane = 'owner' THEN conversation_id END) AS served_conv,
       MIN(CASE WHEN role = 'user' THEN a2a_thread_id END) AS served_thread
  FROM messages
 WHERE served_by_turn IS NOT NULL
 GROUP BY agent_id, served_by_turn;
CREATE UNIQUE INDEX t188_served_key ON t188_served(agent_id, turn_number);

-- (1) Rows the old late stamp DID label: the agent's output in a person's conversation.
UPDATE messages SET subject_kind = 'conv'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL AND conversation_id IS NOT NULL;

-- (2) Agent-to-agent work: the a2a lane, or any own row of an a2a turn. The thread is the
--     turn's own subject id (a terminal wake records it) or the peer row the turn served.
UPDATE messages
   SET a2a_thread_id = (
         SELECT COALESCE(tt.turn_thread, s.served_thread)
           FROM t188_turn tt
           LEFT JOIN t188_served s ON s.agent_id = tt.agent_id AND s.turn_number = tt.turn_number
          WHERE tt.agent_id = messages.agent_id AND tt.turn_number = messages.turn_number)
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL AND a2a_thread_id IS NULL
   AND turn_number IS NOT NULL
   AND (lane = 'a2a' OR EXISTS (SELECT 1 FROM t188_turn tt WHERE tt.agent_id = messages.agent_id
                                   AND tt.turn_number = messages.turn_number AND tt.turn_kind = 'a2a_thread'));

UPDATE messages SET subject_kind = 'a2a_thread'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL
   AND (lane = 'a2a' OR EXISTS (SELECT 1 FROM t188_turn tt WHERE tt.agent_id = messages.agent_id
                                   AND tt.turn_number = messages.turn_number AND tt.turn_kind = 'a2a_thread'));

-- (3) Engine turns.
UPDATE messages SET subject_kind = 'engine_event'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL
   AND EXISTS (SELECT 1 FROM t188_turn tt WHERE tt.agent_id = messages.agent_id
                  AND tt.turn_number = messages.turn_number AND tt.turn_kind = 'engine_event');

-- (4) Wakes that served no conversation (the email wake is one).
UPDATE messages SET subject_kind = 'background'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL
   AND EXISTS (SELECT 1 FROM t188_turn tt WHERE tt.agent_id = messages.agent_id
                  AND tt.turn_number = messages.turn_number AND tt.turn_kind = 'none');

-- (5) A person's turn whose output the late stamp missed: reconstruct its conversation from the
--     turn's trigger, else from what it served; label it `legacy` (see "membership" above).
UPDATE messages
   SET conversation_id = (
         SELECT COALESCE(tt.trigger_conv, s.served_conv)
           FROM t188_turn tt
           LEFT JOIN t188_served s ON s.agent_id = tt.agent_id AND s.turn_number = tt.turn_number
          WHERE tt.agent_id = messages.agent_id AND tt.turn_number = messages.turn_number),
       subject_kind = 'legacy'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL AND conversation_id IS NULL
   AND EXISTS (
         SELECT 1 FROM t188_turn tt
           LEFT JOIN t188_served s ON s.agent_id = tt.agent_id AND s.turn_number = tt.turn_number
          WHERE tt.agent_id = messages.agent_id AND tt.turn_number = messages.turn_number
            AND tt.turn_kind IN ('conv', 'continuation')
            AND COALESCE(tt.trigger_conv, s.served_conv) IS NOT NULL);

-- (6) Everything the box cannot place: no turn number, an orphan turn, a person's turn with no
--     reconstructable conversation. An explicit `unknown`, never NULL.
UPDATE messages SET subject_kind = 'unknown'
 WHERE role IN ('assistant', 'tool') AND subject_kind IS NULL;

DROP TABLE t188_served;
DROP TABLE t188_turn;
