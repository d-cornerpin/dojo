-- 133_drop_dead_stores_and_promote_seq.sql — PHASE-1 T10: the old message system leaves the
-- tree, and the insertion key becomes the primary key.
--
-- Two demolitions and one promotion, in one migration because they are one schema step: the
-- tables go, and the scaffolding that existed to survive them goes with them.
--
-- ════════════════════════════════════════════════════════════════════════════════
-- PART 1 — THREE TABLES DROP. Positive evidence per table (non-negotiable #15: a deletion may
-- never rest on an absence), re-derived at this commit's parent and recorded in
-- .superpowers/sdd/PHASE-1/task-T10-report.md with each command's output.
--
--   `legacy_messages` — created by migration 127's `ALTER TABLE messages RENAME TO
--     legacy_messages`, purely to free the name. The mechanism that replaced it is named and
--     live: migration 127 copied every row into `messages` and every reader in the tree reads
--     `messages`. Complete enumeration, whole repo including tests, dashboard, shared, deploy
--     and the kit:
--       git grep -nP '(^|[^_[:alnum:]])legacy_messages\b' HEAD -- .
--     → 4 hits, ALL of them prose inside shipped migration files (127 ×3, 130 ×1). Zero code.
--
--   `inter_agent_messages` — the second message store (migrations 098/099). T4 folded its
--     writers, T5 and T6 its readers. The one place in the tree that still knew two tables
--     existed was `memory/message-store.ts`'s `home(src)` dispatch, reachable ONLY through a
--     `src: LegacySrc` parameter — and every one of its 34 call sites, enumerated by
--       git grep -nP '\b(setConvKeyByRowid|tagTurnOutputConvKey|claimRowByRowid|
--         claimTrackerNoticeForTask|markServedByRowid|setAnswerMessageId|sweepByRowid|
--         sweepByReferent|sweepById|recordDeliveryAttempt|rehomeUndeliveredCreatedAt|
--         deleteAllForAgent)\s*\(' HEAD -- packages/ | grep -v memory/message-store.ts
--     passes exactly ONE argument. `'ia'` is supplied nowhere in the tree
--     (git grep -nP "'ia'" HEAD -- packages/{server,shared,dashboard}/src → the type
--     declaration, four internal branches and one test comment; no argument). The branch was
--     unreachable, and it goes with the table in this same commit.
--     ⚠ THE 491 ROWS STILL IN IT ARE DROPPED, AND THAT IS BY DESIGN, NOT BY ACCIDENT: this is
--     the disposable dev box, migration 127 deliberately copied `legacy_messages` only, and
--     T5 measured the rows as unreachable by the memory layer (0 double-homed with `messages`,
--     155 inside a live session boundary) with 120 dangling summary links cleaned up by
--     migration 130. Recorded before the fact in .superpowers/sdd/PHASE-1/task-T13-items.md
--     item #10. A LIVED-IN box loses nothing: STABLE-BRIDGE entry #3 (T12) MERGES those rows
--     forward, and this migration is in the local band precisely so it cannot run there first.
--
--   `sessions` — the HTTP/auth session store from migration 006. The mechanism that replaced
--     it is named and live: dashboard auth is STATELESS. `gateway/routes/auth.ts` mints a
--     `jsonwebtoken` signed with `getJwtSecret()` (:35, :51) and a CSRF token generated in
--     memory (`gateway/middleware/auth.ts:85`); the middleware verifies the JWT and touches no
--     database at all — `grep -nP 'getDb|prepare\(' packages/server/src/gateway/middleware/auth.ts`
--     → 0 hits. Complete SQL enumeration, whole repo:
--       git grep -nPi '(FROM|INTO|UPDATE|JOIN|TABLE|EXISTS)\s+sessions\b' HEAD -- .
--     → 1 hit: the `CREATE TABLE` in migration 006. Every other word-bounded `sessions` in the
--     tree is an in-memory Map (`agent/browser.ts`, `voice/voice-ws.ts`), prose, or the
--     unrelated `POST /api/system/reset-idle-sessions` route (agent idle state, not auth).
--     Research 04 row 49 said "DELETE — zero refs, zero rows"; the row count is NOT the
--     evidence here and never was — 0 rows is exactly the reasoning #15 forbids.
--
-- ════════════════════════════════════════════════════════════════════════════════
-- PART 2 — `seq` BECOMES THE PRIMARY KEY. Migrations 127, 131 and 132 each carried a
-- `T10-PROMOTES` marker deferring this, with the reason MEASURED rather than feared. It was
-- re-measured at T10 against this tree's own SQLite (3.49.2) before anything moved:
--
--     CREATE TABLE a (seq INTEGER, id TEXT PRIMARY KEY);              -- today
--     CREATE TABLE b (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE);
--     SELECT rowid, id FROM a   ->  result columns: rowid, id
--     SELECT rowid, id FROM b   ->  result columns: seq,   id      ← same value, new name
--
-- So a bare `SELECT rowid` keeps working and reads back as `undefined` in TypeScript, where
-- the declared row shape is a cast the compiler cannot check. That is why T3's first attempt
-- broke 45 tests SILENTLY — the turn simply stopped claiming its trigger.
--
-- The promotion is safe here because the CODE went first, in the same task and before this
-- file existed: every SELECT-list `rowid` over `messages` now reads `seq AS rowid`
-- (19 sites re-derived at HEAD across 9 files), and a source walk in
-- `memory/__tests__/lane-readers.test.ts` refuses a bare one from here on. The measurement
-- itself is kept as a live assertion in `memory/__tests__/message-store.test.ts`, INVERTED
-- rather than deleted: it now asserts the column IS named `seq`.
--
-- WHAT THE PROMOTION BUYS, beyond tidiness — and this one is a real defect closed:
--   * AUTOINCREMENT. Without it SQLite REUSES the largest rowid after the top row is deleted,
--     and this table has four live delete paths (`deleteForAgentBefore`, `deleteAllForAgent`,
--     `deleteNonSystemForAgent`, `deleteAgentBusRowsFor`). A reused key puts a NEW row at an
--     OLD position in every `ORDER BY seq` tail and BELOW the vault's archive high-water,
--     where it is never copied. `seq` was already the rowid before this migration, so the
--     hazard was already live; the AUTOINCREMENT declaration is what ends it.
--   * `messages_seq_ai` is DELETED. `seq` was kept equal to rowid by an AFTER INSERT trigger
--     firing an UPDATE on every single insert. One integer, addressed by two names, cannot
--     drift — so there is nothing left for a trigger to police.
--   * `ux_msg_seq` is DELETED. A UNIQUE index on the rowid alias is a second B-tree
--     duplicating the table's own key.
--
-- ════════════════════════════════════════════════════════════════════════════════
-- MECHANISM AND ORDER — the repo's standard rebuild (005, 103, 126, 127, 130, 131, 132), with
-- the two hazards those rehearsals recorded:
--   1. `messages_fts` is an fts5 EXTERNAL-CONTENT index (`content='messages'`) keyed by rowid.
--      The copy below carries `seq` explicitly and `seq` IS the new rowid, so every rowid is
--      preserved and the index is never invalidated — which matters because the runner forbids
--      the fts5 'rebuild' command inside a migration transaction (db/migrations.ts:157).
--   2. Trigger and index names are database-global, so the old table's must be dropped before
--      the new table's are created. The view is dropped and recreated because
--      `ALTER TABLE … RENAME` reparses the whole schema and a view pointing at a table that
--      does not exist yet is a parse error at exactly the wrong moment.
--
-- REHEARSED on a `VACUUM INTO` copy of the live dev box with the platform's own driver before
-- it ran for real: row/column/index/trigger parity, FTS parity including a MATCH probe,
-- `integrity_check`, `foreign_key_check`, and two probes the shape check cannot make — that a
-- deleted top row's key is NOT reused, and that a bare `SELECT rowid` now returns `seq`.
-- Transcript: .superpowers/sdd/PHASE-1/task-T10-report.md.
--
-- STABLE BRIDGE: entry #8 (roadmap non-negotiable #5). A lived-in box reaches this migration
-- with real rows in `inter_agent_messages`; entry #3 (T12) merges them into `messages` BEFORE
-- this file's DROP can reach them, and the entry states that ordering as a requirement rather
-- than a hope.

-- ── 1. The three dead tables. Their own indexes drop with them; nothing else in the schema
--       names them (`SELECT type,name FROM sqlite_master WHERE sql LIKE …` → their indexes
--       only), and no other table carries a foreign key into them.
DROP TABLE IF EXISTS legacy_messages;
DROP TABLE IF EXISTS inter_agent_messages;
DROP TABLE IF EXISTS sessions;

-- ── 2. The view and the triggers come off first (names are global).
DROP VIEW IF EXISTS chat_messages;
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_embed_ad;
DROP TRIGGER IF EXISTS messages_seq_ai;

-- ── 3. The table, identical to the live shape except for the two key declarations.
DROP TABLE IF EXISTS messages_new;
CREATE TABLE messages_new (
  -- THE PROMOTION (T10). `seq` is the table's rowid under a name that means something, and
  -- AUTOINCREMENT is not decoration: it is what stops a delete freeing a key for reuse. See
  -- the header. Every marker that deferred this — 127, 131, 132 — is discharged here.
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- `id` keeps its UNIQUE index, which is what `summary_messages.message_id REFERENCES
  -- messages(id)` (migration 130) requires of a parent key. It stops being the PRIMARY KEY,
  -- which it never should have been: it is the row's NAME, not its position.
  id             TEXT NOT NULL UNIQUE,
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
  -- the failure mode that whole task existed to prevent is a writer that keeps handing SQLite
  -- a datetime STRING. Without the CHECK the string stores happily, sorts before nothing,
  -- and every window predicate involving that row quietly returns the wrong answer forever.
  -- With it, the same mistake is an exception at the INSERT, naming the column. No range
  -- bound is asserted: a lived-in box may hold genuinely old rows and the plans do not get
  -- to invent a threshold (non-negotiable #14).
  -- ⚠ T10 NOTE (T13-items #14): these four CHECKs are LOAD-BEARING and they look like
  -- removable belt-and-braces during a cleanup. They are what turned the kit's own instrument
  -- writing a string into a loud failure instead of a vanished row. They stay.
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

-- ── 4. Copy. `seq` IS the new rowid, so carrying it carries the rowid — which is what keeps
--       the fts5 external-content index and the vault high-water meaning exactly what they
--       meant a statement ago. (Naming both `rowid` and `seq` here would be a duplicate
--       column: after the promotion they are two spellings of one thing.)
INSERT INTO messages_new (
  seq, id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
  display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
  source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
  model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
  external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
  served_by_turn, answer_message_id, swept_at, delivery_attempts, next_attempt_at,
  retired_at, conv_key, provenance, sent_at, created_at
)
SELECT
  m.seq, m.id, m.agent_id, m.conversation_id, m.lane, m.origin_intent, m.role,
  m.content, m.mood, m.display_kind, m.display_tier, m.turn_number, m.group_id,
  m.channel, m.sender_id, m.authorized,
  m.source_agent_id, m.a2a_thread_id, m.a2a_intent, m.a2a_requires_response, m.token_count,
  m.model_id, m.cost, m.latency_ms, m.reasoning_content, m.inbound_meta, m.attachments,
  m.external_message_id, m.speaker, m.voice_session_id, m.task_id, m.run_id, m.root_kind,
  m.root_id, m.served_by_turn, m.answer_message_id,
  m.swept_at, m.delivery_attempts, m.next_attempt_at, m.retired_at,
  m.conv_key, m.provenance, m.sent_at, m.created_at
FROM messages m
ORDER BY m.seq;

-- ── 5. Swap.
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- ── 6. Indexes. Identical set and identical names to the ones the dropped table carried,
--       MINUS `ux_msg_seq`: a UNIQUE index on the rowid alias duplicates the table's own key.
CREATE UNIQUE INDEX ux_msg_external ON messages(agent_id, channel, external_message_id)
  WHERE external_message_id IS NOT NULL;
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

-- ── 7. Triggers, unchanged in body. `messages_seq_ai` is NOT recreated: it existed to keep
--       `seq` equal to rowid, and they are the same integer now.
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

-- ── 8. The fail-closed view, unchanged. `SELECT *` still excludes the rowid — and `seq` is a
--       declared column, so the view's column set does not move.
CREATE VIEW chat_messages AS
  SELECT * FROM messages WHERE lane = 'owner' AND retired_at IS NULL;
