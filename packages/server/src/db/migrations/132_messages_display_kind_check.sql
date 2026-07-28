-- 132_messages_display_kind_check.sql — PHASE-1 T8: the display taxonomy becomes a
-- constraint, not a convention.
--
-- WHY THIS EXISTS AT ALL. Migration 127 created `display_kind` as
-- `TEXT NOT NULL DEFAULT 'unclassified'` with the words `T8 owns the classifier + CHECK`
-- written on the same line, while its sibling `display_tier` got a real CHECK immediately.
-- That asymmetry is the half-built shape this rebuild exists to remove, and a marker in the
-- tree has to be true rather than aspirational — so T8 either lands the CHECK or re-dates the
-- marker with a reason. It lands it.
--
-- WHAT IT GUARDS, given two layers already exist. TypeScript types this module's callers, and
-- the single-writer conformance walk refuses raw SQL against `messages` outside the writer.
-- The column is the only layer that can refuse a value arriving any OTHER way — a future
-- migration, a repair script, a `better-sqlite3` handle opened by something nobody remembered.
-- That is the same argument `display_tier`, `lane`, `role`, `authorized` and `provenance` each
-- already won on this table.
--
-- MEASURED BEFORE THE FILE WAS WRITTEN (live dev DB, read-only, 2026-07-28):
--   SELECT display_kind, COUNT(*) FROM messages GROUP BY 1
--     engine-note 1429 · agent-text 1247 · tool-turn 804 · user-text 355 · a2a 34
--     unclassified 25          -> 3894 rows, SIX distinct values, ALL legal below.
-- So this is a pure constraint addition: no row is reclassified, no value is rewritten, and
-- no `content` byte is touched. That last clause is the cache law (OR7 / non-negotiable #10)
-- and it is why the taxonomy T8 adopted was chosen to CONTAIN the values already on disk
-- rather than to replace them — a backfill of a display column would have been cheap and
-- would still have been the wrong instinct.
--
-- `unclassified` IS LEGAL, DELIBERATELY. It is the column's DEFAULT and R1's whole mechanism:
-- a legacy-form `INSERT OR IGNORE` that reaches the table without passing through the writer
-- must still PERSIST. Removing it from this list would re-open the silent-discard window that
-- blocked T3's first attempt. The writer never produces it; `message-store.test.ts` asserts
-- that from the other side.
--
-- MECHANISM: SQLite has no `ALTER TABLE … ADD CONSTRAINT`, so this is the repo's standard
-- rebuild (005, 103, 126, 127, 130, 131): create, copy, drop, rename. The body below is
-- migration 131's, unchanged except for the CHECK — including its two ordering hazards, which
-- are unchanged and still real:
--   1. `messages_fts` is an fts5 EXTERNAL-CONTENT index keyed by rowid. The copy carries
--      `rowid` explicitly and `DROP TABLE` does not fire AFTER DELETE triggers, so the index
--      is never invalidated (the runner forbids fts5 'rebuild' inside a migration
--      transaction, db/migrations.ts:157).
--   2. Trigger names are database-global, so the old table's triggers come off first.
-- The four time columns are ALREADY epoch-ms INTEGER as of 131, so the copy passes them
-- through unchanged; re-running `strftime` over an integer would have produced NULL and
-- aborted on `created_at`'s NOT NULL.
--
-- REHEARSED on a `VACUUM INTO` copy of the live dev box with the platform's own driver before
-- it ran for real: row/column/view/index/trigger parity, FTS docsize parity, integrity_check,
-- and a negative probe proving the CHECK actually refuses an off-enum value. Transcript:
-- .superpowers/sdd/PHASE-1/task-T8-report.md.
--
-- STABLE BRIDGE: entry 8 (roadmap non-negotiable #5).

-- ── 1. The view and the triggers come off first (names are global).
DROP VIEW IF EXISTS chat_messages;
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_embed_ad;
DROP TRIGGER IF EXISTS messages_seq_ai;

-- ── 2. The table, identical to the live shape except for the four columns.
DROP TABLE IF EXISTS messages_new;
CREATE TABLE messages_new (
  -- T10-PROMOTES `seq` to `INTEGER PRIMARY KEY AUTOINCREMENT` and drops `id`'s PK. NOT done
  -- here, for the measured reason recorded in 127: `SELECT rowid` returns a column NAMED
  -- `rowid` while the PK is TEXT and named `seq` the moment an INTEGER PRIMARY KEY alias
  -- exists, so every `row.rowid` in TypeScript would silently become undefined.
  seq            INTEGER,                     -- == rowid, always; maintained by messages_seq_ai
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT,
  lane           TEXT NOT NULL DEFAULT 'owner' CHECK (lane IN ('owner','a2a','events')),
  origin_intent  TEXT,                        -- the second axis on the events lane (T3-0b §2);
                                              -- no lane-restricted CHECK, owner-lane assistant
                                              -- rows carry it and that is PHASE 4's (OR2) subject
  role           TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content        TEXT NOT NULL,               -- written ONCE, never rewritten (cache law)
  mood           TEXT,                        -- extracted, never rendered in content (T8)
  -- ── PHASE-1 T8: the display taxonomy, CHECKed at the database.
  -- `DISPLAY_KINDS` in packages/shared/src/visibility.ts is the same list; the walk in
  -- packages/server/src/__tests__/marker-ownership.test.ts refuses a second copy of any of
  -- these strings elsewhere in the tree, so this and that constant cannot drift apart.
  -- 'unclassified' is the DEFAULT and is legal on purpose: R1 requires that a legacy-form
  -- `INSERT OR IGNORE` reaching this table still PERSISTS rather than vanishing. The writer
  -- module never produces it, which its own tests assert.
  display_kind   TEXT NOT NULL DEFAULT 'unclassified'
                 CHECK (display_kind IN (
                   'user-text','agent-text','tool-turn','working-note','divider',
                   'routing-marker','owner-alert','engine-note','a2a','no-reply-marker',
                   'fallback','unclassified')),
  display_tier   TEXT NOT NULL DEFAULT 'agent-only'      -- fail-closed: visibility is EARNED
                 CHECK (display_tier IN ('user-visible','agent-only','never-shown')),
  turn_number    INTEGER, group_id TEXT,      -- turn_number is the platform's turn allocator and
                                              -- the join key for eleven other tables (T3-0b §4)
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

  -- ── The four. CONVERTED (T6b). Each carries a typeof CHECK, and that guard is the point:
  -- the failure mode this whole task exists to prevent is a writer that keeps handing SQLite
  -- a datetime STRING. Without the CHECK the string stores happily, sorts before nothing,
  -- and every window predicate involving that row quietly returns the wrong answer forever.
  -- With it, the same mistake is an exception at the INSERT, naming the column. No range
  -- bound is asserted: a lived-in box may hold genuinely old rows and the plans do not get
  -- to invent a threshold (non-negotiable #14).
  swept_at       INTEGER CHECK (swept_at IS NULL OR typeof(swept_at) = 'integer'),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR typeof(next_attempt_at) = 'integer'),
  retired_at     INTEGER CHECK (retired_at IS NULL OR typeof(retired_at) = 'integer'),
                                              -- display suppression ONLY (07§2g)
  conv_key       TEXT DEFAULT NULL,           -- PHASE2-DELETES (claim/park machine)
  provenance     TEXT NOT NULL DEFAULT 'live' CHECK (provenance IN ('live','migrated','rescued')),
  sent_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
                 CHECK (sent_at > 1600000000000),
  created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
                 CHECK (typeof(created_at) = 'integer'),
  -- Own-output a2a rows have source_agent_id NULL by design; direction is carried by `role`.
  -- An INBOUND peer row must still name its sender. (T3-0b §3, proven both ways at T3.)
  CHECK (lane <> 'a2a' OR role IN ('assistant','tool') OR source_agent_id IS NOT NULL)
);

-- ── 3. Copy. `rowid` is carried explicitly so the fts5 external-content index and the vault
--       high-water keep meaning exactly what they meant a statement ago.
INSERT INTO messages_new (
  rowid, seq, id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
  display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
  source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
  model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
  external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
  served_by_turn, answer_message_id, swept_at, delivery_attempts, next_attempt_at,
  retired_at, conv_key, provenance, sent_at, created_at
)
SELECT
  m.rowid, m.seq, m.id, m.agent_id, m.conversation_id, m.lane, m.origin_intent, m.role,
  m.content, m.mood, m.display_kind, m.display_tier, m.turn_number, m.group_id,
  m.channel, m.sender_id, m.authorized,
  m.source_agent_id, m.a2a_thread_id, m.a2a_intent, m.a2a_requires_response, m.token_count,
  m.model_id, m.cost, m.latency_ms, m.reasoning_content, m.inbound_meta, m.attachments,
  m.external_message_id, m.speaker, m.voice_session_id, m.task_id, m.run_id, m.root_kind,
  m.root_id, m.served_by_turn, m.answer_message_id,
  m.swept_at, m.delivery_attempts, m.next_attempt_at, m.retired_at,
  m.conv_key, m.provenance, m.sent_at, m.created_at
FROM messages m;

-- ── 4. Swap.
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- ── 5. Indexes, identical set and identical names to the ones the dropped table carried.
CREATE UNIQUE INDEX ux_msg_external ON messages(agent_id, channel, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE UNIQUE INDEX ux_msg_seq ON messages(seq);
CREATE INDEX ix_msg_agent_seq ON messages(agent_id, seq);
CREATE INDEX ix_msg_conv_seq  ON messages(conversation_id, seq);
CREATE INDEX ix_msg_turn ON messages(agent_id, turn_number);
CREATE INDEX ix_msg_unserved ON messages(agent_id, lane, seq)
  WHERE served_by_turn IS NULL AND swept_at IS NULL;
CREATE INDEX idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_messages_run ON messages(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_messages_agent_id ON messages(agent_id);

-- ── 6. Triggers, unchanged in body. None of them reads a time column.
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
CREATE TRIGGER messages_seq_ai AFTER INSERT ON messages WHEN new.seq IS NULL BEGIN
  UPDATE messages SET seq = new.rowid WHERE rowid = new.rowid;
END;

-- ── 7. The fail-closed view, unchanged in meaning. `retired_at IS NULL` is type-agnostic.
CREATE VIEW chat_messages AS
  SELECT * FROM messages WHERE lane = 'owner' AND retired_at IS NULL;
