-- 142_techniques_build_project_on_spine.sql — PHASE-2 T10 (RULING 8a).
--
-- ── WHY A TABLE REBUILD FOR ONE FOREIGN KEY ──
--
-- `legacy_projects` is dead to production (0 SQL statements, 1 comment, re-derived at HEAD)
-- and `141` still could not drop it, because `techniques.build_project_id` carries
-- `REFERENCES "legacy_projects"(id)` and that column is LIVE — written at
-- `techniques/store.ts:188` and `techniques/share-import.ts:172`, read at `store.ts:571`.
--
-- SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`, so re-pointing a foreign key is a table
-- rebuild. This is RULING 3's shape, the same one `138` used for the four side tables.
--
-- ── WHAT DROPPING THE PARENT WOULD ACTUALLY DO (measured on a throwaway copy, not reasoned
--    about — and worse than the obvious guess) ──
--
--   * `PRAGMA foreign_key_check` does NOT error with the parent missing. It reports EVERY
--     child row as a violation (1 genuine -> 2 of 2 in the probe), so the platform's integrity
--     signal does not fail loudly — it turns into noise, which is the harder failure to notice.
--   * an INSERT into `techniques` fails with `no such table: main.legacy_projects` **even when
--     `build_project_id` IS NULL**. So the blast radius is ALL technique creation and every
--     share-import, not merely techniques that name a build project.
--
-- ── WHY `work(id)` IS THE RIGHT NEW PARENT, AND WHY VALUES ARE CARRIED AS-IS ──
--
-- `135` copied every project into `work` with its id preserved (kind='project'), and `138`
-- adopted the 61 post-`135` rows that had no twin. So a `build_project_id` that resolved in
-- `legacy_projects` resolves in `work` under the same id: the values are carried VERBATIM,
-- not remapped. Nulling a resolvable one would destroy a fact the platform recorded ("this
-- technique was built by that project") to make a constraint tidy, which is the trade this
-- project does not make.
--
-- ── THE ONE CASE THAT IS NOT CARRIED, AND THE REHEARSAL IS WHAT FOUND IT ──
--
-- A `build_project_id` naming a project that exists in `legacy_projects` but has NO `work`
-- twin cannot be carried: the line below this one drops `legacy_projects`, so after this file
-- that string points at nothing anywhere. Keeping it would not preserve a fact — the fact is
-- already gone with the parent row — it would preserve a POINTER TO DELETED DATA, and it would
-- leave the database holding a foreign-key violation this file created. The honest value for
-- "the project this was built by no longer exists" is NULL.
--
-- MEASURED BEFORE BEING WRITTEN, on both real bodies, READONLY:
--   dev              techniques with a project 0 · of those unresolved 0 ·
--                    legacy_projects with no work twin 0   (the 135/138 carry is complete)
--   owner's backup   techniques 15 · with a project 0
-- So this clause is a NO-OP on every body that exists, and it is here as a safety net rather
-- than as a repair. It was written because an ADVERSARIAL rehearsal body carrying a technique
-- whose project never reached the spine turned `foreign_key_check` 454 -> 455 — i.e. the file
-- as first drafted introduced a violation of its own. The assertion was not relaxed to fit the
-- file; the file was fixed to keep the assertion.
--
-- ── THE DDL IS `techniques`' OWN, WITH ONE WORD CHANGED ──
--
-- Every column, default and nullability below is copied from the live schema
-- (`SELECT sql FROM sqlite_master WHERE name='techniques'`), including `retire_flagged_at`,
-- which arrived by a later ALTER. The ONLY difference is the parent of `build_project_id`.
-- A rebuild is the one migration shape where a transcription slip silently drops a column, so
-- the rehearsal compares the column list before and after on all three bodies.

CREATE TABLE IF NOT EXISTS techniques_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  author_agent_id TEXT,
  author_agent_name TEXT,
  tags TEXT DEFAULT '[]',
  directory_path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  build_project_id TEXT REFERENCES work(id),
  build_squad_id TEXT REFERENCES agent_groups(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  published_at TEXT,
  retire_flagged_at TEXT DEFAULT NULL
);

INSERT INTO techniques_new (
  id, name, description, state, author_agent_id, author_agent_name, tags, directory_path,
  enabled, version, usage_count, last_used_at, build_project_id, build_squad_id,
  created_at, updated_at, published_at, retire_flagged_at
)
SELECT
  id, name, description, state, author_agent_id, author_agent_name, tags, directory_path,
  enabled, version, usage_count, last_used_at, build_project_id, build_squad_id,
  created_at, updated_at, published_at, retire_flagged_at
FROM techniques;

-- The safety net described above. On every real body this updates ZERO rows.
UPDATE techniques_new
   SET build_project_id = NULL
 WHERE build_project_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = techniques_new.build_project_id);

DROP TABLE techniques;
ALTER TABLE techniques_new RENAME TO techniques;

-- The two indexes go with the dropped table and are recreated by name.
CREATE INDEX IF NOT EXISTS idx_techniques_state ON techniques(state);
CREATE INDEX IF NOT EXISTS idx_techniques_tags  ON techniques(tags);

-- ── AND NOW THE DROP `141` COULD NOT MAKE ──
--
-- VERDICT: STRIP.
-- requirement preserved: THE PROJECT BOARD — every project the platform has ever held. It is
--   `work(kind='project')` with ids carried 1:1 at `135`, the reader-scoped attribute columns
--   moved at `137`, and `work/tracker-view.ts` is the projection every consumer that used to
--   do `SELECT * FROM legacy_projects` reads instead.
-- evidence: 0 production SQL statements at HEAD across `packages/server` AND
--   `packages/dashboard` AND `watchdog/`; the single surviving mention is a comment in
--   `agent/created-by-kind.ts:17` recording a measurement. Its last dependent is re-pointed
--   four statements above this line.
-- this box: 175 rows, all carried into `work` before this file runs.
--
-- Destructive: YES. Same shape and same consequence as Bridge Entry 13 and `141`: on a lived-in
-- box these rows are preserved by `135b_stable_work_spine.sql`, which sorts strictly BEFORE
-- this file; on a box running the local chain WITHOUT the Bridge they go, which on a developer
-- or preflight box is correct.

DROP TABLE IF EXISTS legacy_projects;
