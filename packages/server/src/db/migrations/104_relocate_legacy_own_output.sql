-- 104: D-A step 8 FOLLOW-UP (history relocation). Move the agent's LEGACY
-- pre-step-8 OWN-OUTPUT coordination rows out of the `messages` chat table and
-- into the inter-agent physical store, so regular chat renders the human
-- conversation directly again (no auto-backfill digging on every open) while
-- wordy mode keeps the coordination history via the store arm. Copy + retire
-- marker, NEVER delete: this composes the migration-098 store-backfill idiom
-- (INSERT OR IGNORE ... SELECT) with the migration-102 retire idiom
-- (UPDATE ... SET retired_at), applied to the agent's OWN assistant/tool output.
--
-- Background: since D-A step 8 an inter-agent turn's OWN output (the agent's
-- assistant tool_use rows and its tool_result rows) persists to
-- inter_agent_messages, NOT to `messages` (memory/interagent.ts
-- insertInterAgentOwnOutput). The rows this migration moves are the pre-step-8
-- history that still sits in `messages`: they buried the owner's actual
-- conversation under coordination chatter and forced the chat client to page
-- back through thousands of machine rows before any human turn rendered (the
-- verify-da-step8 check-6 auto-backfill). Relocating them finishes step 8 for
-- the back-catalog: NEW own-output already lands in the store; this brings the
-- OLD own-output to the same home.
--
-- Moved set (owner-ratified scope, migration-104-spec.md):
--   (a) role='assistant' rows stamped source='a2a' (own inter-agent-turn output),
--       un-retired by design at step 7; and
--   (b) role='tool' rows from the SAME turns. Pre-step-8 tool INSERTs carried no
--       source stamp, so they are identified by turn membership: role='tool' AND
--       turn_number NOT NULL AND (agent_id, turn_number) has an un-retired
--       assistant source='a2a' row. Over-inclusion of a mixed turn's human-phase
--       tool rows is harmless (regular mode never renders tool rows; wordy serves
--       the store arm; the model view stays identical by id-dedup).
-- NOT moved: the 1,440 pre-cutover INBOUND peer-A2A rows (role='user'), which the
-- owner explicitly ruled LEAVE-INVISIBLE (2026-07-07); they stay retired-in-
-- `messages`, out of the store, recall-reachable, and are untouched here. System
-- rows stay. Rows already retired (migration 102) stay untouched (retired_at IS
-- NULL guard).
--
-- PROMPT SAFETY (correctness floor, DeepSeek V4 Flash): the MODEL-facing merged
-- readers (memory/store.ts mergedTailQuery / getMessagesByAgentMerged, recall.ts)
-- do NOT consult retired_at and dedup by id (the `messages` arm excludes any id
-- present in the store). So each relocated row is seen EXACTLY ONCE, byte-
-- identical (id/role/content/attachments/turn_number carried across verbatim),
-- from the store arm instead of the `messages` arm. deriveOrigin keeps
-- kind='self' for an assistant/tool row regardless of source, so the assembler's
-- lane partition is unchanged; only origin.channel shifts a2a->null (a dashboard
-- pill detail, re-projected as 'a2a' by the wordy store arm), never the assembled
-- role/content the model reads. Ordering: a relocated row moves from the merged
-- key's messages side (_tag 0) to the store side (_tag 1); at an identical
-- created_at second this can re-order it relative to a NON-relocated same-second
-- `messages` row (CRITICAL INTERACTION 2). This is the same store-after-messages
-- tie-break step 8 already introduced for live own-output, confined to display /
-- same-second ties; the (id, role, content) multiset the model sees is unchanged.
--
-- FTS-inert: the messages FTS trigger is AFTER UPDATE OF content (migration 083),
-- so stamping retired_at rewrites no FTS entry. inter_agent_messages has no FTS.
--
-- ── CRITICAL INTERACTION 1: the store-side archive high-water (migration 100,
-- vault/archive.ts) ──
-- The relocated rows get FRESH inter_agent_messages rowids ABOVE every agent's
-- pre-existing store rows. The session-reset/terminate store archive arm
-- (archiveAgentStoreConversation) copies store rows with rowid > the per-agent
-- high-water (MAX(latest_ia_rowid)); on the common NULL high-water it archives
-- EVERYTHING once. Either way the relocated span would ride the NEXT reset into a
-- giant vault_conversations blob and the Dreamer would re-distill months of stale
-- coordination overnight (the storm-archive shape).
--
-- We do NOT close this by advancing the per-agent high-water over the relocated
-- span, because the relocated rows land ABOVE each agent's LEGITIMATE pre-existing
-- store rows (peer A2A + step-8 native own-output), and on this box most agents
-- (incl. the primary, 565 native store rows, NULL high-water) have those legit
-- rows still pending their first store archive. A single monotonic high-water
-- cannot skip the relocated span on top while still archiving the legit span
-- below it, so a high-water bump would ALSO starve the legit rows the migration-100
-- design intends to first-time archive.
--
-- Instead: a STRUCTURAL exemption. A `relocated_at` marker column stamps every
-- relocated row, and the store archive arm gains `AND relocated_at IS NULL` (see
-- vault/archive.ts archiveAgentStoreConversation) so it archives only store-NATIVE
-- rows. This is correct because the relocated rows are `messages`-origin history
-- that the `messages` archive arm already owned (they rode per-agent archives for
-- months as assistant/tool rows); relocating them must not hand them to the store
-- arm for a second distillation. Post-relocation the `messages` arm also excludes
-- them (id-in-store dedup), so they are archived by NEITHER arm going forward,
-- exactly the intended "already handled, do not re-distill" outcome, with the raw
-- rows persisting in both tables (recall-reachable, never a data loss). The
-- marker is invisible to every merged model reader and to wordy serving (all use
-- explicit column lists); only the `SELECT *` store archive arm sees it.
--
-- Determinism + performance: the tool-row turn membership is materialized ONCE
-- into a TEMP table (with an index) BEFORE the retire UPDATE, so the UPDATE
-- stamping retired_at on the assistant rows cannot shrink the membership set
-- mid-statement (the classic read-the-table-you-are-writing hazard), and the
-- membership IN is an indexed lookup rather than a re-scan. Both the INSERT and
-- the UPDATE use the SAME predicate against that set (textually paired), not the
-- broad id-IN-store form.

-- Guard against a lingering temp table from a partial prior attempt (migrations
-- re-run whole on failure until recorded in _migrations).
DROP TABLE IF EXISTS _mig104_a2a_turns;

CREATE TEMP TABLE _mig104_a2a_turns AS
  SELECT DISTINCT agent_id, turn_number
    FROM messages
   WHERE role = 'assistant'
     AND source = 'a2a'
     AND retired_at IS NULL
     AND turn_number IS NOT NULL;

CREATE INDEX _mig104_a2a_turns_idx ON _mig104_a2a_turns(agent_id, turn_number);

-- Store-archive exemption marker (CRITICAL INTERACTION 1). NULL on every existing
-- (store-native) row; datetime('now') on every row relocated below.
ALTER TABLE inter_agent_messages ADD COLUMN relocated_at TEXT;

-- Copy the own-output rows into the store, ORDER BY rowid so their relative order
-- is preserved under the fresh store rowids. INSERT OR IGNORE keeps the store idiom
-- (a colliding id degrades to a drop) and makes the copy idempotent on re-run.
INSERT OR IGNORE INTO inter_agent_messages
  (id, agent_id, role, content, attachments, conv_key, turn_number, created_at, relocated_at)
SELECT m.id, m.agent_id, m.role, m.content, m.attachments, m.conv_key, m.turn_number,
       m.created_at, datetime('now')
  FROM messages m
 WHERE m.retired_at IS NULL
   AND (
        (m.role = 'assistant' AND m.source = 'a2a')
     OR (m.role = 'tool' AND m.turn_number IS NOT NULL
         AND (m.agent_id, m.turn_number) IN (SELECT agent_id, turn_number FROM _mig104_a2a_turns))
   )
 ORDER BY m.rowid;

-- Retire the SAME rows in `messages` (dashboard serving suppression only; the
-- model-facing readers ignore retired_at). retired_at IS NULL leaves already-
-- retired rows untouched and makes this idempotent on re-run.
UPDATE messages
   SET retired_at = datetime('now')
 WHERE retired_at IS NULL
   AND (
        (role = 'assistant' AND source = 'a2a')
     OR (role = 'tool' AND turn_number IS NOT NULL
         AND (agent_id, turn_number) IN (SELECT agent_id, turn_number FROM _mig104_a2a_turns))
   );

DROP TABLE _mig104_a2a_turns;
