-- 131_messages_epoch_ms_time.sql — PHASE-1 T6b: the spine's four time columns become
-- epoch-ms INTEGER, and every format-sensitive predicate flips in the same commit.
--
-- WHY THIS IS ITS OWN TASK. R3 gave the conversion to T6 as one step of a sweep. T6
-- re-derived the surface, found it reached the model payload, the dashboard package and the
-- vault, and returned it BLOCKED rather than converting half — because a half-converted time
-- column does not fail, it silently returns wrong answers. SQLite orders INTEGER before TEXT
-- unconditionally, so `<integer> < '2026-07-16 18:41:00'` is TRUE for every integer that
-- exists. Every predicate below had to move together or not at all. That is the whole reason
-- this migration and its code changes are one commit.
--
-- WHAT CHANGES: `created_at`, `swept_at`, `next_attempt_at`, `retired_at` on `messages`.
-- TEXT 'YYYY-MM-DD HH:MM:SS' (UTC) -> INTEGER milliseconds since the epoch.
--
-- GRANULARITY IS DELIBERATELY UNCHANGED. The conversion is `strftime('%s', …) * 1000`, the
-- same expression migration 127 already used to fill `sent_at`, so every converted value ends
-- in `000` and no row gains sub-second precision it never had. Ordering, windowing and the
-- rendered stamp therefore all behave exactly as they did; `rowid` remains the tiebreak inside
-- a clock second, which is what the readers already rely on.
--
-- MEASURED ON THIS BOX before the file was written (live DB, read-only, 2026-07-27):
--   total rows                                                                 3766
--   matching 'YYYY-MM-DD HH:MM:SS'                                             3766
--   containing T / Z / fractional seconds                                         0
--   datetime(CAST(strftime('%s',created_at) AS INTEGER),'unixepoch') <> created_at  0
--   swept_at NOT NULL 48 · next_attempt_at NOT NULL 0 · retired_at NOT NULL 0
-- so the epoch round trip is exact and `datetime(created_at/1000,'unixepoch')` reproduces the
-- pre-migration string byte-for-byte. That is load-bearing: it is what lets every read that
-- hands a row to TypeScript keep its declared `string` type, which is what keeps the wire
-- contract, the dashboard (SWEEP-E's) and the per-message prompt stamp byte-identical.
--
-- CACHE LAW (OR7 / non-negotiable #10): `content` is not read, not written and not rewritten
-- here. Timestamps are not content. The per-message stamp `[Jul 16, 2026, 11:41 AM]` that
-- rides into every prompt is pinned BY BYTES, for both the TEXT and the epoch-ms form, in
-- `memory/__tests__/message-time-stamps.test.ts` — landed in the commit BEFORE this one, on
-- purpose, so the flip is provable rather than argued. No assembled-array golden exists until
-- PHASE-3 T1; that pin is its stand-in and says so.
--
-- THE THREE TABLES THAT STAY TEXT, and why that is correct rather than an omission:
--   `agents.session_started_at`, `tasks.updated_at`, `vault_conversations.earliest_at`/
--   `latest_at`. They are not on the spine and no plan gives them to Phase 1. Every predicate
--   that compares one of them against a `messages` time column is converted AT THE COMPARISON
--   (`unixepoch(<text>) * 1000` on the text side, or `datetime(<ms>/1000,'unixepoch')` on the
--   integer side) so the two sides are one type. Those cross-type comparisons are the silent
--   inversions this task exists to prevent; each one is named in the code at its own site.
--
-- MECHANISM: SQLite cannot change a column's declared type in place, and the declared type is
-- exactly what matters here — a column with TEXT affinity converts an integer BACK to text on
-- store, so an in-place `UPDATE` would have produced a table full of TEXT that merely looked
-- converted. This is therefore the repo's standard rebuild (005, 103, 126, 127, 130): create,
-- copy, drop, rename. The rebuild also keeps `created_at`'s `NOT NULL DEFAULT`, which the
-- lighter ADD/DROP/RENAME COLUMN route would have silently discarded — R1 forbids loosening a
-- spine column at a commit boundary, and a NULL `created_at` renders unstamped forever.
--
-- ORDER, and the two hazards it exists to avoid (both inherited from 127's rehearsal notes):
--   1. `messages_fts` is an fts5 EXTERNAL-CONTENT index (`content='messages'`) keyed by rowid.
--      The copy below preserves every rowid, and `DROP TABLE` does not fire AFTER DELETE
--      triggers, so the index is never invalidated and never has to be rebuilt — which matters
--      because the runner forbids the fts5 'rebuild' command inside a migration transaction
--      (db/migrations.ts:157).
--   2. Trigger names are database-global, so the new table's triggers cannot be created while
--      the old table's still exist. They are dropped explicitly first.
--   The view is dropped and recreated for the same reason 127 sequenced carefully: `ALTER
--   TABLE … RENAME` reparses the whole schema, and a view pointing at a table that does not
--   exist yet is a parse error at exactly the wrong moment.
--
-- REHEARSED on a `VACUUM INTO` copy of the live dev box before it ran for real, with the
-- platform's own driver, asserting PER-PREDICATE result-set parity (each predicate's actual
-- row set identical across the flip — not merely equal table counts). Transcript:
-- .superpowers/sdd/PHASE-1/task-T6b-report.md.
--
-- STABLE BRIDGE: entry 7 (roadmap non-negotiable #5). A lived-in box carries TEXT rows in
-- shapes this box does not have (ISO with T/Z, fractional seconds); the entry states what they
-- convert to and why no row is lost.

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
  display_kind   TEXT NOT NULL DEFAULT 'unclassified',   -- 17§C1 enum; T8 owns classifier + CHECK
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
  CAST(strftime('%s', m.swept_at)        AS INTEGER) * 1000,
  m.delivery_attempts,
  CAST(strftime('%s', m.next_attempt_at) AS INTEGER) * 1000,
  CAST(strftime('%s', m.retired_at)      AS INTEGER) * 1000,
  m.conv_key, m.provenance, m.sent_at,
  CAST(strftime('%s', m.created_at)      AS INTEGER) * 1000
FROM messages m;
-- strftime returns NULL for NULL, so the three nullable columns stay NULL without a CASE.
-- It ALSO returns NULL for an unparseable value, which would violate created_at's NOT NULL
-- and abort the whole migration — deliberately. A timestamp nobody can read is not something
-- to convert to a plausible-looking number in silence.

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
