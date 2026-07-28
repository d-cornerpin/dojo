-- 127_unified_messages.sql — PHASE-1 T3: one message table, one writer, one fail-closed reader.
--
-- SHAPE: the COMPATIBILITY cutover (orchestrator adjudication 2026-07-27, option B, R1-R6 in
-- overhaul-plans/PHASE-1.md under T3's resolution block). The plan's literal cutover was
-- rehearsed on a VACUUM INTO copy first and REJECTED on measured evidence:
--   * `INSERT OR IGNORE` applies IGNORE conflict resolution to NOT NULL and CHECK, not only
--     UNIQUE. With undefaulted NOT NULL spine columns, 80 of the platform's 87 message writers
--     would have DISCARDED every row silently -- better-sqlite3 run() -> {"changes":0}, no throw,
--     no log. Control on the old shape: row present.
--   * Renaming `inter_agent_messages` here kills `mergedTailQuery` (memory/store.ts:124-146) and
--     with it every assembled turn: "no such table: inter_agent_messages".
--   * Converting `created_at` to epoch-ms here silently falsifies 42 time-window predicates
--     (SQLite orders INTEGER before TEXT unconditionally), and no task owned them.
-- Transcript: .superpowers/sdd/PHASE-1/task-T3-report.md.
--
-- THEREFORE, and this is scaffolding with a demolition date (R2), not a new design:
--   * every NOT NULL column carries a DEFAULT, so a legacy-form insert still PERSISTS (R1);
--   * `origin_kind` and `source` are carried and a compat trigger derives lane/channel/display
--     from them, so the fail-closed view is never leaky during the changeover -- all `T4-DELETES`;
--   * TEXT time is retained -- R3 gave the conversion to T6; T6 RE-DERIVED the surface
--     (162 mentions in 29 files, 46 format-sensitive) and returned it BLOCKED, on measured
--     evidence that it reaches the model payload, packages/dashboard and the vault. It is
--     still owed; see the dated resolution under the R1-R6 block in overhaul-plans/PHASE-1.md;
--   * `conv_key` is carried -- `PHASE2-DELETES` (T3 Step 2's carry-forward: obligation behaviour
--     does not change this phase);
--   * only `messages` is renamed. `inter_agent_messages` is dropped by T10 once T5 has deleted
--     its readers. The single-writer conformance allowlist is the tripwire the rename was (R5).
-- By T10 the end state is the approved DDL exactly as T3-0b amended it, every marker below gone,
-- proven by grep-zero.

-- ── 1. Drop the four triggers. Trigger names are database-global, so `CREATE TRIGGER messages_ai`
--       on the new table would collide with the renamed table's surviving copy. (T0 measured FOUR,
--       not the plan's five: migration 083 drops and recreates 081's `messages_au`.)
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_embed_ad;

-- ── 2. Rename the old table. This is the only reason to rename: it frees the name.
ALTER TABLE messages RENAME TO legacy_messages;

-- Index names are database-global too, and RENAME carries the old table's eight indexes with it
-- under their original names. They would collide with the new table's below. `legacy_messages` is
-- read only by T10's verification sweep, so it needs none of them.
DROP INDEX IF EXISTS idx_messages_agent_id;
DROP INDEX IF EXISTS idx_messages_created_at;
DROP INDEX IF EXISTS idx_messages_agent_created;
DROP INDEX IF EXISTS idx_messages_agent_turn;
DROP INDEX IF EXISTS idx_messages_task;
DROP INDEX IF EXISTS idx_messages_run;
DROP INDEX IF EXISTS idx_messages_conversation;
DROP INDEX IF EXISTS idx_messages_external_id;

-- ── 3. The unified table.
CREATE TABLE messages (
  -- T10-PROMOTES `seq` to `INTEGER PRIMARY KEY AUTOINCREMENT` and drops `id`'s PK, which is
  -- the approved end state. It is NOT done here, and the reason is measured:
  -- `SELECT rowid FROM t` returns a result column NAMED `rowid` when the PK is TEXT, but
  -- named `seq` the moment an INTEGER PRIMARY KEY alias exists. Same value, different name —
  -- so every `row.rowid` in TypeScript silently becomes `undefined`. That is 37 bare `rowid`
  -- projections over `messages` in 12 files feeding 52 `.rowid` reads, none of which a
  -- typecheck would catch. It broke 45 tests in agent/v2/__tests__/integration.test.ts on the
  -- first run and the failure was silent: the turn simply stopped claiming its trigger.
  -- T5 Step 2 already owns moving readers onto `seq` ("ORDER BY seq replaces
  -- (created_at, _tag, _rowid) everywhere"); the promotion follows them, per R1.
  seq            INTEGER,                     -- == rowid, always; maintained by messages_seq_ai
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT,
  lane           TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
  origin_intent  TEXT,                        -- AMENDED 2026-07-27 (T3-0b §2): KEPT. The second axis
                                              -- that sub-classifies the events lane (17+ live values)
                                              -- and marks engine-composed owner-lane acks. Neither
                                              -- `lane` (3 values) nor `display_kind` (all of them =
                                              -- 'engine-note') can absorb it. NO lane-restricted
                                              -- CHECK -- owner-lane assistant rows carry it and that
                                              -- is PHASE 4's (OR2) subject, not Phase 1's.
  role           TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content        TEXT NOT NULL,               -- written ONCE, never rewritten (cache law)
  mood           TEXT,                        -- extracted, never rendered in content (T8)
  display_kind   TEXT NOT NULL DEFAULT 'unclassified',   -- 17§C1 enum; T8 owns the classifier + CHECK
  display_tier   TEXT NOT NULL DEFAULT 'agent-only'      -- fail-closed default: visibility is EARNED
                 CHECK (display_tier IN ('user-visible','agent-only','never-shown')),
  turn_number    INTEGER, group_id TEXT,      -- AMENDED 2026-07-27 (T3-0b §4): was `turn_id TEXT`.
                                              -- `turn_id` has ZERO references repo-wide and nothing
                                              -- to point at (`turns` PK is the composite
                                              -- (agent_id, turn_number)). `messages.turn_number` is
                                              -- the platform's turn-number ALLOCATOR (loop.ts:1551)
                                              -- and the join key for ELEVEN other tables.
  channel        TEXT, sender_id TEXT,        -- `channel` also absorbs the old `source='voice'`
  authorized     INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0,1)),
  source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
  a2a_requires_response INTEGER,
  token_count    INTEGER NOT NULL DEFAULT 0,  -- estimated at WRITE, never at read
  model_id TEXT, cost REAL, latency_ms INTEGER, reasoning_content TEXT,
  inbound_meta   TEXT, attachments TEXT,
  external_message_id TEXT, speaker TEXT, voice_session_id TEXT,
  task_id TEXT, run_id TEXT, root_kind TEXT, root_id TEXT,
  served_by_turn INTEGER, answer_message_id TEXT,
  swept_at TEXT,                                              -- TIME-CONVERSION-DELETES: still TEXT (see PHASE-1.md, T6 resolution 2)
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                                       -- TIME-CONVERSION-DELETES: still TEXT (see PHASE-1.md, T6 resolution 2)
  retired_at TEXT,                                            -- display suppression ONLY (07§2g)
                                                              -- TIME-CONVERSION-DELETES: still TEXT (see PHASE-1.md, T6 resolution 2)
  origin_kind    TEXT DEFAULT NULL,           -- T10-DELETES (compat: maps onto `lane`, T3-0b §1)
  source         TEXT DEFAULT NULL,           -- T10-DELETES (compat: splits onto `lane`+`channel`, §3)
  -- RE-DATED 2026-07-27 by T4, from `T4-DELETES`, on measured evidence. T4 converted every
  -- WRITER off these two columns (the single writer now derives them from `lane`), but ~120
  -- `origin_kind` and 39 `source` READS are still live and belong to T5/T6. Rehearsed on a
  -- VACUUM INTO copy: dropping them here fails 5 of 5 live reader statements to PREPARE,
  -- including mergedTailQuery — the read behind every assembled turn. R1 forbids that at a
  -- commit boundary, and T10 Step 1b already owns the drop with grep-zero proof.
  -- Transcript: .superpowers/sdd/PHASE-1/task-T4-report.md §7 and migration 128's header.
  conv_key       TEXT DEFAULT NULL,           -- PHASE2-DELETES (claim/park machine, unchanged this phase)
  provenance     TEXT NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','migrated','rescued')),
  sent_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
                 CHECK (sent_at > 1600000000000),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),     -- TIME-CONVERSION-DELETES: still TEXT (see PHASE-1.md, T6 resolution 2)
  -- AMENDED 2026-07-27 (T3-0b §3): the original `CHECK (lane <> 'a2a' OR source_agent_id IS NOT NULL)`
  -- rejects every OWN-OUTPUT a2a row. Own output has source_agent_id NULL by design (memory/
  -- interagent.ts:145-147, insertInterAgentOwnOutput at :158) -- direction is carried by `role`.
  -- An INBOUND peer row must still name its sender. Proven both ways in the T3 rehearsal.
  CHECK (lane <> 'a2a' OR role IN ('assistant','tool') OR source_agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX ux_msg_external ON messages(agent_id, channel, external_message_id)
  WHERE external_message_id IS NOT NULL;      -- account-scoped form (19 §4.14)
CREATE UNIQUE INDEX ux_msg_seq ON messages(seq);
CREATE INDEX ix_msg_agent_seq ON messages(agent_id, seq);
CREATE INDEX ix_msg_conv_seq  ON messages(conversation_id, seq);
CREATE INDEX ix_msg_turn ON messages(agent_id, turn_number);   -- AMENDED 2026-07-27 (T3-0b §4):
                                              -- the shape all five MAX(turn_number) scans and every
                                              -- turn-window query actually use.
CREATE INDEX ix_msg_unserved ON messages(agent_id, lane, seq)
  WHERE served_by_turn IS NULL AND swept_at IS NULL;
-- Carried from the legacy table so no existing read plan regresses during the changeover.
CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_messages_run ON messages(run_id) WHERE run_id IS NOT NULL;

-- ── 4. Copy the legacy rows. rowid is preserved AS seq, so the vault high-waters and the FTS
--       rowid space keep their meaning (T7 re-keys them deliberately, not by accident here).
INSERT INTO messages (
  rowid, seq, id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
  display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
  source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
  model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
  external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
  served_by_turn, answer_message_id, swept_at, delivery_attempts, next_attempt_at,
  retired_at, origin_kind, source, conv_key, provenance, sent_at, created_at
)
SELECT
  m.rowid, m.rowid, m.id, m.agent_id, m.conversation_id,
  CASE WHEN m.origin_kind = 'engine' THEN 'events'
       WHEN m.source = 'a2a' THEN 'a2a'
       ELSE 'owner' END,
  m.origin_intent, m.role, m.content, NULL,
  CASE WHEN m.origin_kind = 'engine' THEN 'engine-note'
       WHEN m.source = 'a2a' THEN 'a2a'
       WHEN m.role = 'user' THEN 'user-text'
       WHEN m.role = 'assistant' THEN 'agent-text'
       WHEN m.role = 'tool' THEN 'tool-turn'
       ELSE 'engine-note' END,
  CASE WHEN m.origin_kind = 'engine' OR m.source = 'a2a' OR m.role IN ('system','tool')
       THEN 'agent-only' ELSE 'user-visible' END,
  m.turn_number, NULL,
  CASE WHEN m.source = 'voice' THEN 'voice'
       ELSE json_extract(m.inbound_meta, '$.channel') END,
  NULL,
  CASE WHEN m.role <> 'user' THEN 1
       WHEN json_extract(m.inbound_meta, '$.authorized') IN (1, 'true') THEN 1
       WHEN m.inbound_meta IS NULL THEN 1
       ELSE 0 END,
  m.source_agent_id, m.a2a_thread_id, m.a2a_intent, m.a2a_requires_response,
  COALESCE(m.token_count, MAX(1, LENGTH(m.content) / 4)),
  m.model_id, m.cost, m.latency_ms, m.reasoning_content, m.inbound_meta, m.attachments,
  m.external_message_id, m.speaker, m.voice_session_id, m.task_id, m.run_id, m.root_kind, m.root_id,
  m.served_by_turn, m.answer_message_id, m.swept_at, m.delivery_attempts, m.next_attempt_at,
  m.retired_at, m.origin_kind, m.source, m.conv_key, 'migrated',
  CAST(strftime('%s', m.created_at) AS INTEGER) * 1000,
  m.created_at
FROM legacy_messages m;

-- ── 5. The four triggers, recreated on the new table against the new rowid column.
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_embed_ad AFTER DELETE ON messages BEGIN
  DELETE FROM embeddings WHERE source_type = 'message' AND source_id = old.id;
END;

-- T10-DELETES (with the promotion). Keeps `seq` equal to rowid for every row, so readers
-- can migrate to `seq` (T5) before `seq` becomes the physical primary key (T10) — and the
-- values never change when it does.
CREATE TRIGGER messages_seq_ai AFTER INSERT ON messages WHEN new.seq IS NULL BEGIN
  UPDATE messages SET seq = new.rowid WHERE rowid = new.rowid;
END;

-- ── 6. T4-DELETES. The compatibility trigger.
-- Until T4 re-points the writers, a legacy INSERT supplies `origin_kind`/`source` and knows nothing
-- of `lane`. Without this the row would land as lane='owner' and ENGINE AND PEER TRAFFIC WOULD BE
-- VISIBLE THROUGH `chat_messages` -- the exact leak the fail-closed view exists to prevent. It fires
-- only on rows the writer module did not classify, so it is a no-op for `message-store.ts` (which
-- passes origin_kind/source NULL and always sets display_kind), and it never touches `content`, so
-- no historical prompt byte is rewritten and `messages_au` (AFTER UPDATE OF content) never fires.
-- T4 DROPS this trigger in the commit that empties the writer allowlist.
CREATE TRIGGER messages_compat_ai AFTER INSERT ON messages
WHEN new.origin_kind IS NOT NULL OR new.source IS NOT NULL OR new.display_kind = 'unclassified'
BEGIN
  UPDATE messages SET
    lane = CASE WHEN new.origin_kind = 'engine' THEN 'events'
                WHEN new.source = 'a2a' THEN 'a2a'
                ELSE new.lane END,
    channel = COALESCE(new.channel,
                CASE WHEN new.source = 'voice' THEN 'voice'
                     ELSE json_extract(new.inbound_meta, '$.channel') END),
    authorized = CASE WHEN new.role <> 'user' THEN 1
                      WHEN json_extract(new.inbound_meta, '$.authorized') IN (1, 'true') THEN 1
                      WHEN new.inbound_meta IS NULL THEN 1
                      ELSE new.authorized END,
    token_count = CASE WHEN new.token_count = 0
                       THEN MAX(1, LENGTH(new.content) / 4) ELSE new.token_count END,
    display_kind = CASE WHEN new.display_kind <> 'unclassified' THEN new.display_kind
                        WHEN new.origin_kind = 'engine' THEN 'engine-note'
                        WHEN new.source = 'a2a' THEN 'a2a'
                        WHEN new.role = 'user' THEN 'user-text'
                        WHEN new.role = 'assistant' THEN 'agent-text'
                        WHEN new.role = 'tool' THEN 'tool-turn'
                        ELSE 'engine-note' END,
    display_tier = CASE WHEN new.display_kind <> 'unclassified' THEN new.display_tier
                        WHEN new.origin_kind = 'engine' OR new.source = 'a2a'
                             OR new.role IN ('system','tool') THEN 'agent-only'
                        ELSE 'user-visible' END
  WHERE rowid = new.rowid;
END;

-- ── 7. Rebuild the FTS index onto the new rowid space.
-- The runner forbids the fts5 'rebuild' command inside a migration transaction
-- (db/migrations.ts:157), so the index is dropped, redeclared against `seq` and repopulated.
DROP TABLE IF EXISTS messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);
INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages;

-- ── 8. The fail-closed default accessor (22 §2.4). A forgetful reader OMITS agent traffic rather
--       than leaking it -- the protection the old two-table split provided, without its damage.
CREATE VIEW chat_messages AS
  SELECT * FROM messages WHERE lane = 'owner' AND retired_at IS NULL;
