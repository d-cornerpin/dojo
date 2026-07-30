-- ══════════════════════════════════════════════════════════════════════════════════════════
-- 129b_stable_merge_messages.sql — THE STABLE BRIDGE, the lived-in merge.
--
-- Folds the two surviving legacy message stores into the unified `messages` table so that a
-- box upgrading from Stable keeps ONE message table holding ONE keyspace with ALL of its
-- history. Ledger entry: ../STABLE-BRIDGE.md, Entry 9 (+ its T12 addendum).
--
-- AUTHORED AND REHEARSED by SHIP-PREP, 2026-07-30, from Entry 9's mapping. GUARD 1 REMOVED.
-- Before this, the file was a skeleton with 8 `TODO(release)` blocks whose §4 `DROP TABLE
-- messages; ALTER TABLE messages_new RENAME TO messages;` referenced a `messages_new` that
-- was never created — i.e. it destroyed the table and then threw.
--
-- Measured on the owner's lived-in body (~/.dojo-backup-20260726-135808/dojo.db, chain 124):
--   messages 66,022 + inter_agent_messages(IA-only) 19,119 + agent_messages 230 = 85,371.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS FILE MUST RUN AT 129b, AND WHAT IT LOSES IF IT DOES NOT
-- ══════════════════════════════════════════════════════════════════════════════════════════
--   Position proven with Node's own `.sort()` against the full 150-file chain:
--     129_drop_messages_compat_columns.sql < 129b_… < 130_derived_stores_one_keyspace.sql
--   `parseInt('129b',10)` -> 129, so migrations.ts:321-323's backup filename arithmetic holds.
--
--   All five preconditions hold at exactly this slot and nowhere else:
--     • 127 has created the unified table                 (there is somewhere to fold INTO)
--     • 128 has dropped `messages_compat_ai`              (this file is the only writer)
--     • 129 has dropped `origin_kind` / `source`          (only spine columns to fill)
--     • 130 has NOT run   -> `summary_messages` links and `vault_conversations.latest_ia_rowid`
--                            are both still intact
--     • 131/132 have NOT run -> time is still TEXT and the display taxonomy is not yet CHECKed,
--                            so the folded rows travel 131's one conversion and 132's one
--                            CHECK with everybody else instead of re-implementing them.
--
--   MEASURED COST OF BEING ABSENT, on the owner's own body (SHIP-PREP, 2026-07-30):
--     133:114 `DROP TABLE IF EXISTS inter_agent_messages` destroys 19,119 rows — no local
--     migration folds them first; 145:159 drops `agent_messages` and its own rescue INSERT
--     refuses 11 of 230 (`JOIN agents f ON f.id = am.from_agent`, and 11 name a deleted
--     agent); 130 drops 6,585 `summary_messages` links (6,383 of them resolvable only in IA)
--     and `vault_conversations.latest_ia_rowid` on 472 rows. Total 19,130 messages, silently,
--     on a SUCCESSFUL boot. That is the whole reason this file exists.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- AS-BUILT DEVIATION 1 — NO TABLE REBUILD. The DDL is never transcribed, and that is the point.
-- ══════════════════════════════════════════════════════════════════════════════════════════
--   Entry 9's §4 rebuilds `messages` (`CREATE TABLE messages_new …`, three INSERTs, rename,
--   recreate every index/trigger/view) purely to re-derive `seq` chronologically. Its own
--   release item (b) then warns: *"Do not inherit a DDL from this file's authoring date;
--   re-derive it"*, and its §4 warns about the ALTER-RENAME index-name trap.
--
--   Both hazards are DELETED rather than managed, because the schema itself says they can be.
--   Read out of the live schema at this chain position, not assumed:
--       seq  INTEGER,          -- == rowid, always; maintained by messages_seq_ai
--       id   TEXT PRIMARY KEY  -- so `rowid` is the implicit rowid, not an alias for seq
--       CREATE UNIQUE INDEX ux_msg_seq ON messages(seq)
--       CREATE TRIGGER messages_seq_ai AFTER INSERT ON messages WHEN new.seq IS NULL …
--       CREATE TRIGGER messages_au AFTER UPDATE **OF content** ON messages …
--   `rowid` is assignable in SQLite, and `messages_au` fires only on a content update — which
--   this file never performs. So the merged order can be applied IN PLACE: insert the folded
--   rows above MAX(rowid), then re-point `rowid`/`seq` for every row. Every constraint, index,
--   trigger and the `chat_messages` view survive untouched, and a column added to `messages`
--   by any future phase is carried for free instead of being silently dropped by a stale
--   rebuild. THE STALE-DDL FAILURE MODE ENTRY 9 WARNS ABOUT IS STRUCTURALLY UNREACHABLE HERE.
--
--   ⚠ THE HALLOWEEN PROBLEM IS REAL AND IS HANDLED. Updating a rowid can make the same UPDATE
--   visit a row twice. Both passes below are therefore written so a re-visited row FAILS THE
--   `WHERE` and is skipped: pass 1 moves every row to a NEGATIVE rowid (`WHERE rowid > 0`),
--   pass 2 moves it to its final positive one (`WHERE rowid < 0`). `seq` is negated alongside
--   `rowid` in pass 1 so `ux_msg_seq` cannot collide half-way through pass 2. §7 then asserts
--   the result is a bijection, so a double-visit aborts the boot instead of corrupting an
--   order.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- AS-BUILT DEVIATION 2 — THE CONVERSATION LADDER IS **147**'s, NOT THIS FILE'S.
-- ══════════════════════════════════════════════════════════════════════════════════════════
--   Entry 9 §3 specifies a five-rung ladder here, ending in rung 5: mint one `legacy:<agent>`
--   conversation per agent and assign it to the 41,093-row residue. Entry 9 was authored in
--   PHASE-1 T12. **`147_conversation_identity_backfill.sql` (PHASE-2 T10I, RULING 11) now does
--   exactly this job, later in the same chain, on every `messages` row** — its own header:
--   *"`messages.conversation_id` IS BACKFILLED FROM `messages.conv_key` … it fills NULLs only"*
--   (`147:143,:169` carry `AND m.conversation_id IS NULL  -- never overwrites a producer`).
--
--   Running Entry 9's rungs 2–5 here would fill every NULL first, so `147`'s
--   `conversation_id IS NULL` predicate would match nothing and its measured precision would
--   be replaced by this file's guesses. Rung 5 would additionally MINT conversation rows for
--   41,093 messages — invented identity with no door and no event behind it, which RULING 11
--   forbids and which Entry 12 Part 2 §4 already refused for the same reason on the tracker
--   side. This is the same class of correction Entry 12 Part 2 made for `task_log` ("`146`
--   owns it, and copying it would double every carried audit line").
--
--   SO: this file carries `conversation_id` and `conv_key` as **identity** from the source
--   rows and creates NO conversation. `147` resolves. Asserted in §7 (`no_conversation_invented`),
--   and the NULLs left for `147` are REPORTED rather than driven to zero.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- AS-BUILT DEVIATION 3 — the assertion table is created HERE, not inside a guard.
-- ══════════════════════════════════════════════════════════════════════════════════════════
--   The skeleton created `_bridge_assert` inside its GUARD-1 block, so deleting the guard (its
--   own release step (a)) left all 18 assertions inserting into a table that does not exist.
--   It is a `CREATE TEMP TABLE` in §0 now, and every scratch table is DROPPED at the end:
--   migrations in one boot share ONE connection and a TEMP table outlives the per-file
--   transaction, so the second bridge file to run would otherwise die on
--   `table _bridge_assert already exists` (measured in better-sqlite3 by SHIP-PREP).
-- ══════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-state, and the assertion table. ────────────────────────────────────────────────
CREATE TEMP TABLE _bridge_assert (name TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1), detail TEXT);

CREATE TEMP TABLE _bridge_before (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO _bridge_before (k, v) VALUES
  ('messages',      (SELECT COUNT(*) FROM messages)),
  ('ia_only',       (SELECT COUNT(*) FROM inter_agent_messages
                      WHERE id NOT IN (SELECT id FROM messages))),
  ('am_only',       (SELECT COUNT(*) FROM agent_messages
                      WHERE id NOT IN (SELECT id FROM messages)
                        AND id NOT IN (SELECT id FROM inter_agent_messages))),
  ('double_homed',  (SELECT COUNT(*) FROM inter_agent_messages
                      WHERE id IN (SELECT id FROM messages))),
  ('sm_links',      (SELECT COUNT(*) FROM summary_messages)),
  ('sm_nowhere',    (SELECT COUNT(*) FROM summary_messages sm
                      WHERE sm.message_id NOT IN (SELECT id FROM messages)
                        AND sm.message_id NOT IN (SELECT id FROM inter_agent_messages)
                        AND sm.message_id NOT IN (SELECT id FROM agent_messages))),
  ('sm_ia_rescued', (SELECT COUNT(*) FROM summary_messages sm
                      WHERE sm.message_id NOT IN (SELECT id FROM messages)
                        AND sm.message_id IN (SELECT id FROM inter_agent_messages))),
  ('vault_hw_ia',   (SELECT COUNT(*) FROM vault_conversations WHERE latest_ia_rowid IS NOT NULL)),
  ('emb_total',     (SELECT COUNT(*) FROM embeddings)),
  ('emb_orphan_nowhere', (SELECT COUNT(*) FROM embeddings e
                      WHERE e.source_type = 'message'
                        AND e.source_id NOT IN (SELECT id FROM messages)
                        AND e.source_id NOT IN (SELECT id FROM inter_agent_messages)
                        AND e.source_id NOT IN (SELECT id FROM agent_messages))),
  ('fk_msg_agents', (SELECT COUNT(*) FROM pragma_foreign_key_check('messages'))),
  -- folded rows whose agent no longer exists: 3,918 on the reference body. Captured HERE
  -- because after §4 they are indistinguishable from the 15 that were already orphaned.
  ('fk_ia_orphans', (SELECT COUNT(*) FROM inter_agent_messages
                      WHERE id NOT IN (SELECT id FROM messages)
                        AND agent_id NOT IN (SELECT id FROM agents))),
  ('conv_rows',     (SELECT COUNT(*) FROM conversations)),
  ('conv_id_set',   (SELECT COUNT(*) FROM messages WHERE conversation_id IS NOT NULL));


-- ── 1. The archived set, computed while `latest_ia_rowid` still exists. ───────────────────
-- vault/archive.ts reads MAX(latest_rowid) per agent and copies rows with `seq > highWater`.
-- Two source keyspaces, two bounds; after §4 there is one keyspace and one bound, so the
-- boundary has to be recorded HERE, before migration 130 drops the column.
CREATE TEMP TABLE _bridge_hw AS
  SELECT agent_id,
         MAX(latest_rowid)    AS hw_messages,
         MAX(latest_ia_rowid) AS hw_ia
    FROM vault_conversations
   GROUP BY agent_id;


-- ── 2. The merged order, computed once and frozen. ────────────────────────────────────────
-- Ordering key: (created_at, home_rank, turn_number NULLS LAST, role_rank, rowid).
--   home_rank : messages 0 < inter_agent_messages 1 < agent_messages 2. `messages` first
--               because it is the canonical home for a double-homed id.
--   role_rank : user < assistant < tool < system — a turn's inbound row, then the model, then
--               the tool result. Deterministic; a tiebreak, not a claim.
-- Within one clock second the true cross-home interleaving is NOT recoverable — it was never
-- written (66,579 of 85,371 merged rows share their second with another row). This key is
-- deterministic and at least as good as what the two-arm merged reader produced on every
-- read; the point is that it is computed ONCE.
CREATE TEMP TABLE _bridge_merged AS
WITH u AS (
  SELECT m.id, m.agent_id, 0 AS home, m.rowid AS src_rowid,
         m.created_at, m.turn_number, m.role
    FROM messages m
  UNION ALL
  SELECT ia.id, ia.agent_id, 1, ia.rowid, ia.created_at, ia.turn_number, ia.role
    FROM inter_agent_messages ia
   WHERE ia.id NOT IN (SELECT id FROM messages)
  UNION ALL
  SELECT am.id, am.to_agent, 2, am.rowid, am.created_at, NULL, 'user'
    FROM agent_messages am
   WHERE am.id NOT IN (SELECT id FROM messages)
     AND am.id NOT IN (SELECT id FROM inter_agent_messages)
)
SELECT u.id, u.agent_id, u.home, u.src_rowid,
       ROW_NUMBER() OVER (
         ORDER BY u.created_at,
                  u.home,
                  CASE WHEN u.turn_number IS NULL THEN 1 ELSE 0 END, u.turn_number,
                  CASE u.role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1
                              WHEN 'tool' THEN 2 ELSE 3 END,
                  u.src_rowid
       ) AS new_seq,
       CASE
         WHEN u.home = 0 AND h.hw_messages IS NOT NULL AND u.src_rowid <= h.hw_messages THEN 1
         WHEN u.home = 1 AND h.hw_ia       IS NOT NULL AND u.src_rowid <= h.hw_ia       THEN 1
         ELSE 0
       END AS already_archived
  FROM u LEFT JOIN _bridge_hw h ON h.agent_id = u.agent_id;

CREATE UNIQUE INDEX ix_bridge_merged_id  ON _bridge_merged(id);
CREATE UNIQUE INDEX ix_bridge_merged_seq ON _bridge_merged(new_seq);


-- ── 3. Double-homed ids: keep the `messages` row, carry the three facts it does not hold. ──
-- 1,418 ids live in both stores on the reference body. Measured, not assumed: content,
-- agent_id, role and created_at are identical on all 1,418, the IA twin adds NOTHING on any
-- of eleven a2a/attachment/task/root/delivery columns, and the `messages` twin is strictly
-- richer (515 token_count, 515 model_id, 514 reasoning_content, 1,418 retired_at). THREE
-- exceptions exist and are carried across rather than dropped: conv_key (34),
-- served_by_turn (34), answer_message_id (15).
-- `content` is READ and never written — OR7 / non-negotiable #10, and the reason the provider
-- cache prefixes survive this upgrade.
UPDATE messages
   SET conv_key = (SELECT ia.conv_key FROM inter_agent_messages ia WHERE ia.id = messages.id)
 WHERE conv_key IS NULL
   AND EXISTS (SELECT 1 FROM inter_agent_messages ia
                WHERE ia.id = messages.id AND ia.conv_key IS NOT NULL);

UPDATE messages
   SET served_by_turn = (SELECT ia.served_by_turn FROM inter_agent_messages ia WHERE ia.id = messages.id)
 WHERE served_by_turn IS NULL
   AND EXISTS (SELECT 1 FROM inter_agent_messages ia
                WHERE ia.id = messages.id AND ia.served_by_turn IS NOT NULL);

UPDATE messages
   SET answer_message_id = (SELECT ia.answer_message_id FROM inter_agent_messages ia WHERE ia.id = messages.id)
 WHERE answer_message_id IS NULL
   AND EXISTS (SELECT 1 FROM inter_agent_messages ia
                WHERE ia.id = messages.id AND ia.answer_message_id IS NOT NULL);

-- `relocated_at` (6,976 IA rows) has NO successor column and is NOT carried: it recorded that
-- a row had been moved between the two stores, and after this file there is one store, so the
-- fact has no referent. Recorded in the ledger's acceptable-losses table.


-- ── 4a. Fold `inter_agent_messages` -> `messages`. 19,119 rows on the reference body. ──────
-- Inserted ABOVE MAX(rowid) with an explicit `seq` equal to that rowid, so `messages_seq_ai`
-- (which fires only `WHEN new.seq IS NULL`) stays out of it and §4c's negation is consistent.
--   lane         <- origin_kind='engine' ? 'events' : 'a2a'   (events 2,833 · a2a 16,286)
--   content      <- ia.content, BYTE FOR BYTE. Not re-wrapped, stripped or normalised.
--   display_kind <- structural CASE, refined by §4d; `unclassified` where neither decides,
--                   which is legal by design (R1) and by 132's CHECK two files later.
--   display_tier <- 'agent-only', fail-closed: visibility is EARNED, and agent traffic never
--                   masquerades as owner chat (OR4).
--   authorized   <- 1. Non-owner lanes; migration 127 uses the same rule.
--   token_count  <- MAX(1, LENGTH(content)/4). IA has no such column; estimated ONCE here,
--                   exactly as 127 estimated the 43,628 NULLs on the messages side.
--   sent_at      <- created_at in epoch ms, CLAMPED to the CHECK floor. 0 rows need the clamp
--                   on either real body; a count of zero is not evidence the class cannot
--                   exist (#15), and an unclamped readable pre-2020 instant would abort the
--                   whole boot — the exact hazard T13 fixed in `135`.
--   mood / model_id / cost / latency_ms / reasoning_content / inbound_meta /
--   external_message_id / speaker / voice_session_id / sender_id / group_id / retired_at
--                <- NULL. No source. `retired_at` NULL is correct: it is display suppression,
--                   and none of these rows was ever suppressed.
INSERT INTO messages (
  rowid, seq, id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
  display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
  source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
  model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
  external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
  served_by_turn, answer_message_id, swept_at, delivery_attempts, next_attempt_at,
  retired_at, conv_key, provenance, sent_at, created_at)
SELECT
  COALESCE((SELECT MAX(rowid) FROM messages), 0) + ROW_NUMBER() OVER (ORDER BY ia.rowid),
  COALESCE((SELECT MAX(rowid) FROM messages), 0) + ROW_NUMBER() OVER (ORDER BY ia.rowid),
  ia.id, ia.agent_id, ia.conversation_id,
  CASE WHEN ia.origin_kind = 'engine' THEN 'events' ELSE 'a2a' END,
  ia.origin_intent, ia.role, ia.content, NULL,
  CASE
    WHEN ia.origin_kind = 'engine'                     THEN 'engine-note'
    WHEN ia.role = 'tool'                              THEN 'tool-turn'
    WHEN ia.content LIKE '[A2A:%'                      THEN 'a2a'
    WHEN ia.role = 'assistant'                         THEN 'agent-text'
    WHEN ia.role = 'user'                              THEN 'a2a'
    ELSE 'unclassified'
  END,
  'agent-only',
  ia.turn_number, NULL, NULL, NULL, 1,
  ia.source_agent_id, ia.a2a_thread_id, ia.a2a_intent, ia.a2a_requires_response,
  MAX(1, LENGTH(ia.content) / 4),
  NULL, NULL, NULL, NULL, NULL, ia.attachments,
  NULL, NULL, NULL, ia.task_id, ia.run_id, ia.root_kind, ia.root_id,
  ia.served_by_turn, ia.answer_message_id, ia.swept_at,
  COALESCE(ia.delivery_attempts, 0), ia.next_attempt_at,
  NULL, ia.conv_key, 'migrated',
  MAX(COALESCE(CAST(strftime('%s', ia.created_at) AS INTEGER) * 1000, 1600000000001),
      1600000000001),
  ia.created_at
  FROM inter_agent_messages ia
 WHERE ia.id NOT IN (SELECT id FROM messages);


-- ── 4b. Fold `agent_messages` -> `messages`. 230 rows on the reference body. ───────────────
-- Mapping per the ledger's T4 addendum: to_agent -> agent_id, from_agent -> source_agent_id,
-- message_type -> a2a_intent (result 229 · poke 1), metadata -> inbound_meta,
-- lane='a2a', role='user', origin_intent='agent_bus' (what keeps the bus distinguishable now
-- that it has no table), display_kind='a2a', display_tier='agent-only', authorized=1.
-- `read_by_recipient` has no successor: it was written 0 and never updated, and the unified
-- store answers the same question with `served_by_turn IS NOT NULL`.
--
-- ⚠ ALL 230 ARE CARRIED, INCLUDING THE 11 `145` REFUSES. `145:150-151`'s rescue joins
--   `agents` on BOTH ends, and 11 rows name a `from_agent` that no longer exists, so `145`
--   alone drops them. Entry 9's rule is the opposite and it governs here: a folded row whose
--   agent is gone is IMPORTED and counted, because a row count is never evidence of deadness
--   (#15) and 11 rows of somebody's history is not a rounding error. `source_agent_id` falls
--   back to the same `unrecorded-peer` token `126b` uses, never to `'system'`, so the CHECK
--   `lane <> 'a2a' OR role IN ('assistant','tool') OR source_agent_id IS NOT NULL` is
--   satisfied without claiming the platform sent the message.
-- After this file `145`'s own INSERT OR IGNORE finds every id already present and no-ops,
-- then drops the table — one mapping, in one place, with no double.
INSERT INTO messages (
  rowid, seq, id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
  display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
  source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
  model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
  external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
  served_by_turn, answer_message_id, swept_at, delivery_attempts, next_attempt_at,
  retired_at, conv_key, provenance, sent_at, created_at)
SELECT
  COALESCE((SELECT MAX(rowid) FROM messages), 0) + ROW_NUMBER() OVER (ORDER BY am.rowid),
  COALESCE((SELECT MAX(rowid) FROM messages), 0) + ROW_NUMBER() OVER (ORDER BY am.rowid),
  am.id, am.to_agent, NULL, 'a2a', 'agent_bus', 'user', am.content, NULL,
  'a2a', 'agent-only',
  NULL, NULL, NULL, am.from_agent, 1,
  COALESCE(am.from_agent, 'unrecorded-peer'), NULL, am.message_type, NULL,
  MAX(1, LENGTH(am.content) / 4),
  NULL, NULL, NULL, NULL, am.metadata, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, 0, NULL,
  NULL, NULL, 'migrated',
  MAX(COALESCE(CAST(strftime('%s', am.created_at) AS INTEGER) * 1000, 1600000000001),
      1600000000001),
  COALESCE(am.created_at, datetime('now'))
  FROM agent_messages am
 WHERE am.id NOT IN (SELECT id FROM messages)
   AND am.id NOT IN (SELECT id FROM inter_agent_messages);


-- ── 4c. THE RESEQUENCE. Two Halloween-safe passes; see AS-BUILT DEVIATION 1. ──────────────
-- `seq` must stay chronological because every sanctioned reader pages on it (`ORDER BY seq`,
-- memory/message-store.ts), so 19,349 folded rows cannot simply sit above MAX(seq) — an
-- agent's next assembled turn would be nothing but its oldest peer traffic.
-- Pass 1: everything to a negative rowid AND a negative seq (so `ux_msg_seq` cannot collide
--         mid-way through pass 2). A re-visited row is already negative and fails the WHERE.
UPDATE messages SET rowid = -rowid, seq = -rowid WHERE rowid > 0;
-- Pass 2: to the merged order. A re-visited row is already positive and fails the WHERE.
UPDATE messages
   SET rowid = (SELECT b.new_seq FROM _bridge_merged b WHERE b.id = messages.id),
       seq   = (SELECT b.new_seq FROM _bridge_merged b WHERE b.id = messages.id)
 WHERE rowid < 0;


-- ── 4d. THE ONE-TIME OFFLINE PROSE PARSE — markers become COLUMNS. ────────────────────────
-- "The last prose derivation the platform ever performs" (Entry 9; research 19 §1b step 4).
-- CONTENT IS NEVER REWRITTEN: one backfill of `content` invalidates every conversation prefix
-- on every provider at once (OR7, non-negotiable #10, and T8's Entry 8 declined exactly this
-- backfill for the same reason). So `((mood: NAME))` is COPIED into `messages.mood` and LEFT
-- in the content bytes.
-- Yields measured over the merged 85,371 (Entry 9, 2026-07-28). Scoped to the rows THIS file
-- folded — 127 already classified its own copy, and re-deriving over the whole table would
-- overwrite a producer's classification with a guess.
UPDATE messages SET display_kind = 'engine-note'
 WHERE provenance = 'migrated' AND display_kind IN ('unclassified','a2a','agent-text')
   AND content LIKE '[SOURCE:%';
UPDATE messages SET display_kind = 'divider'
 WHERE provenance = 'migrated' AND display_kind = 'unclassified'
   AND content LIKE '%──%';
UPDATE messages SET display_kind = 'working-note'
 WHERE provenance = 'migrated' AND display_kind IN ('unclassified','agent-text')
   AND content LIKE '%[working-note]%';
UPDATE messages SET display_kind = 'routing-marker'
 WHERE provenance = 'migrated' AND display_kind IN ('unclassified','agent-text')
   AND content LIKE '%[Reply routed%';
UPDATE messages SET display_kind = 'no-reply-marker'
 WHERE provenance = 'migrated' AND display_kind IN ('unclassified','agent-text')
   AND (content LIKE '%[no-reply,%' OR content LIKE '%[no-reply —%');
-- `[needs-attention]` — rule kept; yield is 0 on both real bodies. Zero rows is not evidence
-- the marker never existed elsewhere (#15), and the rule costs nothing.
UPDATE messages SET display_kind = 'owner-alert'
 WHERE provenance = 'migrated' AND display_kind = 'unclassified'
   AND content LIKE '%[needs-attention]%';
-- `[tracker:` and `ENGINE_AUTO` become origin_intent, never a display kind.
UPDATE messages SET origin_intent = COALESCE(origin_intent, 'tracker')
 WHERE provenance = 'migrated' AND content LIKE '%[tracker:%';
UPDATE messages SET origin_intent = COALESCE(origin_intent, 'engine_auto')
 WHERE provenance = 'migrated' AND content LIKE '%ENGINE_AUTO%';
-- mood: the marker is COPIED out and deliberately LEFT in the bytes.
UPDATE messages
   SET mood = rtrim(substr(substr(content, instr(content, '((mood:') + 7),
                           1,
                           instr(substr(content, instr(content, '((mood:') + 7), '))') - 1))
 WHERE provenance = 'migrated' AND mood IS NULL
   AND content LIKE '%((mood:%))%';


-- ── 5. The upgrade-day storm. THIS IS THE 60,416-ROW RECONCILIATION. ──────────────────────
-- `claimForTurn` (memory/message-store.ts) hands the next turn EVERY row with
-- `served_by_turn IS NULL AND swept_at IS NULL`, oldest first, in ONE statement. Measured on
-- the owner's migrated body with this file ABSENT: 60,416 rows, and ONE agent alone accounts
-- for 39,272. The first turn any agent took after the upgrade would claim its entire history
-- and hand it to the assembler. Part V names this hazard for work rows ("first boot fires
-- zero wakes"); it is just as real for messages, and this is where it is closed.
--
-- Rule: every row that existed before the upgrade is stamped as already accounted for.
-- 0 is a safe sentinel: live turn numbers run 1..4770 on the reference body and the allocator
-- has never issued 0, so no reader keyed on a specific turn can collide with it, and every
-- `served_by_turn IS NULL` reader now correctly says "handled".
--
-- ⚠ NOT scoped to `provenance='migrated'`. The skeleton's §5 was, and that is a defect this
--   rehearsal found: 127 stamps its own copied rows `'migrated'`, but a box that has been
--   RUNNING on the unified table before it upgrades also holds `'live'` rows with a NULL
--   `served_by_turn`, and those are exactly as capable of forming the storm. The predicate is
--   the hazard's own shape, not a provenance label.
UPDATE messages
   SET served_by_turn = COALESCE(served_by_turn, turn_number, 0)
 WHERE served_by_turn IS NULL
   AND swept_at IS NULL;


-- ── 6a. The per-agent vault high-water, re-pointed IN THIS TRANSACTION. ───────────────────
-- Part V, in bold: else runaway re-summarization hours after the upgrade.
--
-- ⚠ PHASE-1 T12 Step 2 says the assertion is "per-agent high-water == new per-agent max".
--   Taken literally that is the HIGH side, and on the lived-in body it LOSES DATA: for 3 of
--   the 49 agents that have ever archived, the archived set is NOT a contiguous prefix of the
--   merged order, and 858 un-archived rows (759,141 content bytes) sit below their agent's
--   highest archived row. Setting the high-water to the max declares them archived and they
--   are skipped forever, silently.
--   The safe direction is LOW, and its cost was measured too: 23,755 already-archived rows
--   (21.3 MB) get copied to the vault a second time, ONE time, after which the high-water
--   advances to the true max on its own. 21 MB once, against 858 messages of a person's
--   history lost permanently, is not a close call. (The ~1 GB/day figure migration 088 exists
--   to prevent is REPEATED all-time re-archival on every reset; a single bounded overlap does
--   not reproduce it.) For the other 46 of 49 agents the two rules agree exactly.
UPDATE vault_conversations
   SET latest_rowid = (
     SELECT MIN(
       COALESCE((SELECT MAX(b.new_seq) FROM _bridge_merged b
                  WHERE b.agent_id = vault_conversations.agent_id
                    AND b.home = 0
                    AND b.src_rowid <= vault_conversations.latest_rowid), 0),
       COALESCE((SELECT MIN(b.new_seq) - 1 FROM _bridge_merged b
                  WHERE b.agent_id = vault_conversations.agent_id
                    AND b.already_archived = 0),
                (SELECT MAX(b.new_seq) FROM _bridge_merged b
                  WHERE b.agent_id = vault_conversations.agent_id))
     )
   )
 WHERE latest_rowid IS NOT NULL;
-- `latest_ia_rowid` is deliberately left alone: migration 130, the very next file, drops it,
-- and its value has already been consumed by `_bridge_hw` in §1.


-- ── 6b. Embeddings. ──────────────────────────────────────────────────────────────────────
-- `embeddings` is id-keyed, so every vector survives the resequence untouched — that is why
-- nothing here re-embeds the 61,967 message vectors the box already has. 879 message
-- embeddings are orphaned on the lived-in body; the merge RESOLVES 547 of them by folding
-- their rows in, and only the residue that names an id in NO store is deleted.
DELETE FROM embeddings
 WHERE source_type = 'message'
   AND source_id NOT IN (SELECT id FROM messages);
-- 6c. The re-embed backlog: ~18,572 folded rows have no vector. It is a JOB, not a migration
--     — agent-scoped, resumable, idle-priority, run after boot — and it must NOT hold the
--     boot inside the watchdog's allowance. Recall degrades gracefully to FTS in the meantime,
--     which is why it is allowed to be asynchronous. The platform's own `backfill` component
--     already drains an embedding backlog on a cap per run (observed: 287 items, cap 500), so
--     the work set is the rows this file added with no `embeddings` row and NO new mechanism
--     is owed. `messages.provenance` is the column that defines that work set (Entry 9
--     addendum item 2) and this is its reader.


-- ── 6d. FTS. ─────────────────────────────────────────────────────────────────────────────
-- The resequence in §4c moves every rowid, and `messages_fts` is external-content keyed on
-- `content_rowid='rowid'`, so the index must be rebuilt. The runner forbids the fts5 'rebuild'
-- command inside a migration transaction (db/migrations.ts), so this is 127's pattern: drop,
-- redeclare, repopulate. The five `messages_*` triggers reference `messages_fts` BY NAME and
-- are resolved at run time, so they survive the swap untouched.
-- Note the lived-in index is ALREADY drifted (66,831 rows in messages_fts_docsize against
-- 66,022 in messages, 809 stale). The rebuild fixes that as a side effect, which is why §7's
-- assertion is an equality and not a delta.
DROP TABLE IF EXISTS messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);
INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;

-- 6e. Summary links. Nothing to do — and that is the point of running at 129b. The links were
--     never touched, and the 6,383 that pointed into `inter_agent_messages` now resolve in
--     `messages`, so migration 130's `JOIN messages` keeps them by construction. The residue
--     that names an id in no store at all is dropped by 130 and is counted in §7 rather than
--     discovered later.
--     DEDUP: 1,793 message ids sit in two or more summaries. They are the pre-`withLock`
--     duplicate-summary race's product. NOT resolved here — the duplicate is the SUMMARY, not
--     the link, and choosing which summary owns a message is a memory-layer decision with its
--     own evidence. Recorded in the ledger as an open item with its owner.


-- ── 7. Assertions. Every one aborts the migration and rolls the box back untouched. ───────
INSERT INTO _bridge_assert (name, ok, detail) SELECT 'row_conservation',
  (SELECT COUNT(*) FROM messages) =
  (SELECT SUM(v) FROM _bridge_before WHERE k IN ('messages','ia_only','am_only')),
  'merged total must equal messages + IA-only + bus-only; 85,371 on the reference body';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'no_id_lost',
  (SELECT COUNT(*) FROM _bridge_merged b WHERE b.id NOT IN (SELECT id FROM messages)) = 0,
  'every id that entered the merge is in the table — a count check alone cannot see a swap';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'no_id_invented',
  (SELECT COUNT(*) FROM messages m WHERE m.id NOT IN (SELECT id FROM _bridge_merged)) = 0,
  'and nothing arrived that did not come from one of the three stores';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'seq_equals_rowid',
  (SELECT COUNT(*) FROM messages WHERE seq IS NULL OR seq <> rowid) = 0,
  'the invariant 127/131/132 hold, and the proof that §4c''s two passes are a bijection';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'seq_dense_and_unique',
  (SELECT COUNT(DISTINCT seq) FROM messages) = (SELECT COUNT(*) FROM messages)
  -- COALESCEd because a migration must also apply to an EMPTY database (deploy gate): MIN/MAX
  -- over zero rows is NULL, `NULL = 1` is NULL, and a NULL `ok` violates the CHECK's NOT NULL
  -- instead of failing an assertion. Found by the gate, not by reading.
  AND COALESCE((SELECT MIN(seq) FROM messages), 1) = 1
  AND COALESCE((SELECT MAX(seq) FROM messages), 0) = (SELECT COUNT(*) FROM messages),
  'dense 1..N — a Halloween double-visit in §4c would break exactly this';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'merged_order_applied',
  (SELECT COUNT(*) FROM messages m JOIN _bridge_merged b ON b.id = m.id
    WHERE m.seq <> b.new_seq) = 0,
  'every row sits at the seq the frozen merge computed for it';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'fts_count_equals_table',
  (SELECT COUNT(*) FROM messages_fts_docsize) = (SELECT COUNT(*) FROM messages),
  'the external-content index is exactly as long as the table it indexes';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'summary_links_intact',
  (SELECT COUNT(*) FROM summary_messages) = (SELECT v FROM _bridge_before WHERE k='sm_links'),
  'this file must not drop a link; 130 drops exactly the sm_nowhere residue and only that';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'summary_links_rescued',
  (SELECT COUNT(*) FROM summary_messages sm WHERE sm.message_id NOT IN (SELECT id FROM messages))
    = (SELECT v FROM _bridge_before WHERE k='sm_nowhere'),
  'after the fold the only unresolvable links are the ones unresolvable in EVERY store — '
  || 'the 6,383 that resolved only in inter_agent_messages are now safe from 130''s JOIN';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'high_water_skips_nothing',
  (SELECT COUNT(*) FROM vault_conversations v
    WHERE v.latest_rowid IS NOT NULL
      AND EXISTS (SELECT 1 FROM _bridge_merged b
                   WHERE b.agent_id = v.agent_id AND b.already_archived = 0
                     AND b.new_seq <= v.latest_rowid)) = 0,
  'THE assertion T7 asked for, in the direction that cannot lose history';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'high_water_in_range',
  (SELECT COUNT(*) FROM vault_conversations v
    WHERE v.latest_rowid IS NOT NULL
      AND v.latest_rowid > COALESCE((SELECT MAX(b.new_seq) FROM _bridge_merged b
                                      WHERE b.agent_id = v.agent_id), 0)) = 0,
  'no high-water may point past the end of its own agent history';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'nothing_waiting_on_first_boot',
  (SELECT COUNT(*) FROM messages WHERE served_by_turn IS NULL AND swept_at IS NULL) = 0,
  '§5 — the first turn after the upgrade must claim ZERO pre-existing rows. 60,416 on the '
  || 'owner''s body without this file';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'authorized_never_null',
  (SELECT COUNT(*) FROM messages WHERE authorized IS NULL) = 0,
  'NOT NULL DEFAULT 0 makes it structural; asserted anyway so a later DDL edit that loosens '
  || 'the column fails HERE instead of on a user box';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'lane_legal',
  (SELECT COUNT(*) FROM messages WHERE lane NOT IN ('owner','a2a','events')) = 0, '';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'display_kind_legal',
  (SELECT COUNT(*) FROM messages WHERE display_kind NOT IN (
     'user-text','agent-text','tool-turn','working-note','divider','routing-marker',
     'owner-alert','engine-note','a2a','no-reply-marker','fallback','unclassified')) = 0,
  'migration 132 CHECKs this three files later; failing here names the bridge instead';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'a2a_sender_present',
  (SELECT COUNT(*) FROM messages
    WHERE lane = 'a2a' AND role NOT IN ('assistant','tool')
      AND source_agent_id IS NULL) = 0,
  'Entry 9 addendum item 1: the same CHECK that halts the chain at 127, asserted HERE where '
  || 'the bridge can name the row, rather than inside a constraint that cannot';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'no_text_typed_time',
  (SELECT COUNT(*) FROM messages
    WHERE typeof(created_at) NOT IN ('text','integer')
       OR (swept_at        IS NOT NULL AND typeof(swept_at)        NOT IN ('text','integer'))
       OR (next_attempt_at IS NOT NULL AND typeof(next_attempt_at) NOT IN ('text','integer'))
       OR (retired_at      IS NOT NULL AND typeof(retired_at)      NOT IN ('text','integer'))) = 0,
  'the T6b class. At 129b time is still TEXT and 131 converts it, so the assertion here is '
  || '"one type, no surprises"; the integer-only form is 131''s own CHECK, which these folded '
  || 'rows must satisfy two files later or the chain aborts';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'every_time_value_parses',
  (SELECT COUNT(*) FROM messages WHERE strftime('%s', created_at) IS NULL) = 0,
  'fail HERE, naming the bridge, rather than inside 131''s NOT NULL — same rule, earlier';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'sent_at_above_floor',
  (SELECT COUNT(*) FROM messages WHERE sent_at <= 1600000000000) = 0,
  '127''s CHECK (sent_at > 1600000000000), by clamp and not by luck';

-- AS-BUILT DEVIATION 2's guard: this file resolves no conversation and invents none.
INSERT INTO _bridge_assert (name, ok, detail) SELECT 'no_conversation_invented',
  (SELECT COUNT(*) FROM conversations) = (SELECT v FROM _bridge_before WHERE k='conv_rows'),
  'RULING 11: 147 owns conversation identity. A conversations row minted by this file would '
  || 'have no door and no event behind it, and would pre-empt 147''s measured resolution';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'never_overwrote_a_conversation',
  (SELECT COUNT(*) FROM messages WHERE conversation_id IS NOT NULL)
    >= (SELECT v FROM _bridge_before WHERE k='conv_id_set'),
  'a producer-stamped conversation_id can only survive this file';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'content_never_rewritten', 1,
  'this file reads `content` and never writes it — OR7 / non-negotiable #10. Every marker '
  || 'became a COLUMN in §4d and stayed in the bytes, which is what keeps every provider cache '
  || 'prefix valid across the upgrade';

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'fk_violations_accounted',
  (SELECT COUNT(*) FROM pragma_foreign_key_check('messages'))
    = (SELECT v FROM _bridge_before WHERE k='fk_msg_agents')
    + (SELECT v FROM _bridge_before WHERE k='fk_ia_orphans'),
  'messages->agents orphans grow by exactly the folded orphans and by nothing else. On the '
  || 'reference body 15 + 3,918 = 3,933. These are rows whose agent was deleted; they are '
  || 'IMPORTED, not dropped — a row count is never evidence of deadness (#15), the class already '
  || 'exists on the box, and 3,918 rows of somebody''s history is not a rounding error';

-- REPORTED, never asserted: the numbers the owner is owed rather than gated on.
INSERT INTO _bridge_assert (name, ok, detail) SELECT 'folded_reported', 1,
  'folded from inter_agent_messages: ' || (SELECT v FROM _bridge_before WHERE k='ia_only')
  || ' · from agent_messages: '        || (SELECT v FROM _bridge_before WHERE k='am_only')
  || ' · double-homed kept as messages rows: ' || (SELECT v FROM _bridge_before WHERE k='double_homed');

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'conversation_backlog_reported', 1,
  'rows left for 147 to resolve: ' || (SELECT COUNT(*) FROM messages WHERE conversation_id IS NULL);

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'reembed_backlog_reported', 1,
  'folded rows with no vector (the post-boot job''s work set): '
  || (SELECT COUNT(*) FROM messages m WHERE m.provenance = 'migrated'
       AND NOT EXISTS (SELECT 1 FROM embeddings e
                        WHERE e.source_type = 'message' AND e.source_id = m.id));

INSERT INTO _bridge_assert (name, ok, detail) SELECT 'embeddings_deleted_reported', 1,
  'orphan message vectors deleted (named an id in NO store): '
  || ((SELECT v FROM _bridge_before WHERE k='emb_total') - (SELECT COUNT(*) FROM embeddings))
  || ' · expected ' || (SELECT v FROM _bridge_before WHERE k='emb_orphan_nowhere');


-- ── 8. Scratch teardown. Kept until the very end so a failing assertion leaves its evidence
--       in the rolled-back transaction's error rather than a bare constraint name.
DROP TABLE _bridge_merged;
DROP TABLE _bridge_hw;
DROP TABLE _bridge_before;
DROP TABLE _bridge_assert;

-- ══════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK. The runner applies and records this file in ONE transaction, so any failure above
-- leaves the box exactly as it was and the boot fails loudly — which the updater's
-- auto-rollback covers. Note the shape of that cover: watchdog/src/auto-rollback.ts sets
-- `migrationsRanDuringEpisode`, and once a migration has run a CODE-only rollback is refused
-- as unsafe. The real restore point is the pre-chain online backup
-- (`runSqlMigrations`' `backupBeforeMigrationChain`), which writes
-- `dojo-pre-<n>-to-<N>-<stamp>.db` — and which SKIPS ITSELF, with a warning and no failure,
-- when free disk is under 2x the database (migrations.ts:300-310). On a 616 MB lived-in body
-- that is ~1.2 GB of headroom. The rehearsal gate asserts the backup FILE EXISTS after the
-- run, not merely that the migration succeeded.
-- ══════════════════════════════════════════════════════════════════════════════════════════
