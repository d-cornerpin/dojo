-- REQUIRES-COLUMN: work.hold_kind
-- A hold the owner set before 901 is recorded as his: 901 kept the hold but wrote no `hold_set` entry, so it
-- read as the worker's. The owner's old moves carry actor `user` or `by: 'owner'`. Appends only.
INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT w.id, 'audit', json_object('entry_kind', 'hold_set', 'from_status', NULL, 'to_status', w.hold_kind,
         'reason', COALESCE(w.hold_reason, ''), 'action_taken', NULL, 'note', 'set by the owner before the upgrade',
         'evidence_json', NULL), 'owner', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  FROM work w
 WHERE w.hold_kind IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work_events h WHERE h.work_id = w.id AND h.kind = 'audit'
                     AND CASE WHEN json_valid(h.payload) THEN json_extract(h.payload, '$.entry_kind') END = 'hold_set')
   AND (SELECT e.actor = 'user' OR CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.by') END = 'owner'
          FROM work_events e
         WHERE e.work_id = w.id AND e.kind = 'transition'
           AND e.id < (SELECT MIN(id) FROM work_events WHERE actor = 'migration-901')
           AND CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.to') END IN ('paused', 'blocked')
         ORDER BY e.id DESC LIMIT 1)
 ORDER BY w.id;
