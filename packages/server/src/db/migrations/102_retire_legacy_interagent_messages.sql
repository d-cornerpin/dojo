-- 102: D-A step 7 (history retire). Retire the LEGACY pre-cutover inter-agent
-- rows that still sit in the `messages` chat table so they stop being SERVED to
-- the dashboard chat surface, while staying fully recoverable. Marker over
-- deletion: `messages` is immutable history, never hard-deleted.
--
-- Background: D-A gave inter-agent (A2A) traffic its own physical store
-- (inter_agent_messages, migrations 098/099). Every NEW peer-A2A and every
-- engine-origin notice/event lands there now (steps 1-6, verified). The ONLY
-- inter-agent rows left in `messages` are the pre-cutover history. Step 5 kept a
-- dashboard 'a2a' user-role visibility overlay SOLELY to hide those legacy rows
-- from chat; this migration retires them at the source so that overlay can drop.
--
-- Mechanism: a dedicated `retired_at` suppression column, exactly the `swept_at`
-- idiom from migration 082 (a drain/serving-suppression marker, never a content
-- or identity edit, never a DELETE). Only the DASHBOARD serving predicates read
-- it: the chat history route (gateway/routes/chat.ts) and the origin projection
-- (gateway/routes/agents.ts) add `AND retired_at IS NULL`. Nothing else consults
-- it.
--
-- Retired set (identical to the store's own membership predicate AND the harness
-- leak invariant's "A2A shape"): role='user' rows whose attribution marks them as
-- inter-agent: a peer A2A row (source_agent_id or a2a_thread_id set) or an
-- engine-origin notice/event (origin_kind='engine').
--
-- PROMPT SAFETY (correctness floor, DeepSeek V4 Flash): the MODEL-facing readers
-- are UNTOUCHED. The merged tail loaders (memory/store.ts getRecentMessagesMerged
-- / getMessagesByAgentMerged) and recall (memory/recall.ts) do NOT consult
-- retired_at; they still UNION `messages` with the store and partition on the same
-- origin columns. So a retired row is byte-identical in any assembled prompt AND
-- still recoverable by the agent's recall tools. Retiring is purely a
-- dashboard-serving concern; it cannot change what any live session's model call
-- sees (which is also why no session-boundary guard is needed on the retire).
--
-- FTS-inert: the messages FTS update trigger is `AFTER UPDATE OF content` since
-- migration 083, so stamping retired_at rewrites no FTS entry.

ALTER TABLE messages ADD COLUMN retired_at TEXT;

UPDATE messages
   SET retired_at = datetime('now')
 WHERE role = 'user'
   AND retired_at IS NULL
   AND (source_agent_id IS NOT NULL
        OR a2a_thread_id IS NOT NULL
        OR origin_kind = 'engine');
