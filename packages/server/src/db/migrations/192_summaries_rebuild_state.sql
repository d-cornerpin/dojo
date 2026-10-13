-- 192 (t144): EVERY CONDENSED NOTE SAYS WHICH ONE CONVERSATION IT IS ABOUT — the notes already on
-- the box labelled once, and the recent mixed ones queued for the rebuild.
--
-- ── WHAT WAS WRONG (tracker #12 RC3, OR-V333-SET (8), OR-LABEL-NOT-HIDE) ──
-- The condensing engine chunked an agent's rows agent-wide, so one note could hold the owner's
-- dashboard request and an email thread's notices, undated, with no conversation on it. From this
-- release a note is written about ONE conversation (`memory/summary-subject.ts`) and carries it in
-- `subject_key`. This file gives the notes already on the box the same key, from their own source
-- rows, and marks the ones that mixed conversations.
--
-- ── THE STATES (the CHECK below is the authority) ──
--   subject_key set, rebuild_state NULL   a note about one conversation (most notes)
--   legacy_mixed_rebuild                  mixed, and EVERY surviving source row is from the 14 days
--                                         before this update: the nightly job re-condenses it, one
--                                         note per conversation, from the original messages
--                                         (owner ruling OR-REBUILD-SCOPE, 2026-10-12)
--   legacy_mixed                          mixed, older: NEVER rebuilt, stays visible labelled
--                                         "older mixed notes, <date range>"
--   lineage_lost                          no source row survives: the content stays, labelled
--                                         "conversation unknown, <date range>" — nothing invented
-- Original messages are never touched. The key of a row is the same function the engine writes
-- with (`rowSubjectKey`); `memory/__tests__/t144-migration-192-labels-older-notes.test.ts` holds the
-- two to the same answers on an adversarial body.
--
-- ── SAFETY ──
-- Adds two nullable columns and one table; writes only those columns; deletes nothing; cannot
-- RAISE (no JSON function; every value written is a key built from stored ids or one of the CHECK's
-- words). IDEMPOTENT BY PREDICATE: every UPDATE requires `subject_key IS NULL AND rebuild_state IS
-- NULL`, so a second pass matches nothing. One pass over `summary_messages` (temp tables, built once).
-- A downgraded version ignores both columns and the table; a note it writes is classified by the same
-- rule when the job next runs (`classifyUnlabelledNotes`).

ALTER TABLE summaries ADD COLUMN subject_key TEXT;
ALTER TABLE summaries ADD COLUMN rebuild_state TEXT
  CHECK (rebuild_state IS NULL OR rebuild_state IN ('legacy_mixed', 'legacy_mixed_rebuild', 'lineage_lost'));

-- The rebuild's staged notes: written one per finished chunk, swapped in for an agent's whole set at
-- once. A row survives a crash, so an interrupted rebuild resumes without paying for a chunk twice.
-- No foreign key on purpose: an older version may delete the note a row replaces; the job drops it.
CREATE TABLE IF NOT EXISTS summary_rebuild_staged (
  unit_id     TEXT NOT NULL,   -- the older mixed note these notes replace
  chunk_key   TEXT NOT NULL,   -- the chunk's identity: its source message ids, in order
  agent_id    TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  message_ids TEXT NOT NULL,   -- JSON array of message ids, oldest first
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (unit_id, chunk_key)
);

-- (0) Every note to classify, with every summary below it (a condensed note reaches its leaves).
CREATE TEMP TABLE t192_desc AS
WITH RECURSIVE d(root, id) AS (
  SELECT id, id FROM summaries WHERE subject_key IS NULL AND rebuild_state IS NULL
  UNION
  SELECT d.root, sp.parent_id FROM d JOIN summary_parents sp ON sp.summary_id = d.id
)
SELECT root, id FROM d;
CREATE INDEX t192_desc_id ON t192_desc(id);

-- (1) Per note: how many conversations its surviving source rows span, and its oldest source row.
CREATE TEMP TABLE t192_root AS
SELECT d.root AS root,
       COUNT(DISTINCT k.key) AS keys,
       MIN(k.key) AS one_key,
       MIN(k.created_at) AS first_at
  FROM t192_desc d
  JOIN summary_messages sm ON sm.summary_id = d.id
  JOIN (SELECT m.id AS id, m.created_at AS created_at,
               CASE
                 WHEN m.role = 'system' THEN NULL
                 WHEN m.role = 'user' AND (m.lane = 'a2a' OR m.source_agent_id IS NOT NULL) THEN 'a2a:' || COALESCE(m.a2a_thread_id, '')
                 WHEN m.role = 'user' AND m.lane = 'events' THEN 'engine'
                 WHEN m.role = 'user' THEN COALESCE('conv:' || m.conversation_id, 'unknown')
                 WHEN m.subject_kind IN ('conv', 'legacy', 'delivered') THEN COALESCE('conv:' || m.conversation_id, 'unknown')
                 WHEN m.subject_kind = 'a2a_thread' THEN 'a2a:' || COALESCE(m.a2a_thread_id, '')
                 WHEN m.subject_kind = 'engine_event' THEN 'engine'
                 WHEN m.subject_kind = 'background' THEN 'background'
                 WHEN m.subject_kind = 'unknown' THEN 'unknown'
                 ELSE COALESCE('conv:' || m.conversation_id, 'a2a:' || m.a2a_thread_id, 'unknown')
               END AS key
          FROM messages m) k ON k.id = sm.message_id
 GROUP BY d.root;
CREATE UNIQUE INDEX t192_root_key ON t192_root(root);

-- (2) One conversation: its key.
UPDATE summaries SET subject_key = (SELECT r.one_key FROM t192_root r WHERE r.root = summaries.id)
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 1);

-- (3) Source rows survive but none names a conversation (only system rows): conversation unknown.
UPDATE summaries SET subject_key = 'unknown'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 0);

-- (4) Mixed, every surviving source row inside the 14 days before this update: queued for the rebuild.
UPDATE summaries SET rebuild_state = 'legacy_mixed_rebuild'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root
               WHERE keys > 1 AND first_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 14 * 86400) * 1000);

-- (5) Mixed and older: labelled, never rebuilt.
UPDATE summaries SET rebuild_state = 'legacy_mixed'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys > 1);

-- (6) No source row survives: the note keeps its content, labelled "conversation unknown".
UPDATE summaries SET rebuild_state = 'lineage_lost'
 WHERE subject_key IS NULL AND rebuild_state IS NULL;

DROP TABLE t192_root;
DROP TABLE t192_desc;
