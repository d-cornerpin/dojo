// t144 — migration 192's classification, as the nightly job re-runs it (see the block below).

/**
 * The classification rule: migration 192's own statements (its comments stripped), re-run over notes
 * nobody labelled — those a downgraded version wrote. Idempotent by predicate. ONE rule: a test holds
 * this text byte-equal to the migration file's (`t144-migration-192-labels-older-notes.test.ts`).
 */
export const CLASSIFY_SQL = `CREATE TEMP TABLE t192_desc AS
WITH RECURSIVE d(root, id) AS (
  SELECT id, id FROM summaries WHERE subject_key IS NULL AND rebuild_state IS NULL
  UNION
  SELECT d.root, sp.parent_id FROM d JOIN summary_parents sp ON sp.summary_id = d.id
)
SELECT root, id FROM d;
CREATE INDEX t192_desc_id ON t192_desc(id);

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

UPDATE summaries SET subject_key = (SELECT r.one_key FROM t192_root r WHERE r.root = summaries.id)
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 1);

UPDATE summaries SET subject_key = 'unknown'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 0);

UPDATE summaries SET rebuild_state = 'legacy_mixed_rebuild'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root
               WHERE keys > 1 AND first_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 14 * 86400) * 1000);

UPDATE summaries SET rebuild_state = 'legacy_mixed'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys > 1);

UPDATE summaries SET rebuild_state = 'lineage_lost'
 WHERE subject_key IS NULL AND rebuild_state IS NULL;

DROP TABLE t192_root;
DROP TABLE t192_desc;`;
