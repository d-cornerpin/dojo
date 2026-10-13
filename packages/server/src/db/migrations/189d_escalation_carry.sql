-- 189d (v3.3.3 t142, fix round 1, review I1): UPGRADE DAY TELLS THE OWNER NOTHING ABOUT A
-- LONG-DEAD ROW HE WAS ALREADY TOLD ABOUT.
--
-- WHAT CHANGED UNDER IT. Until v3.3.3 the owner-escalation ladder's suppressor was "this row
-- has a `validation_escalated` stamp, EVER". t142 scopes it per episode for BLOCKED rows — the
-- one ruled shape: told about a block, reopened, blocked again on a new obstacle => told again
-- (`work/validation-drive.ts:ownerEpisodeSettledExpr`). Applied to history, that rule would
-- re-open every row that was escalated once and has since been blocked again, possibly months
-- ago, and the first sweeps after the upgrade would steer the primary about a batch of them
-- and then put a "Heads up" in front of the owner — the burst the review measured (I1) and
-- the upgrade-integrity standard forbids.
--
-- THE CARRY. For EXACTLY that set — a row in `blocked` now, whose newest stamp predates its
-- last entry into `blocked` — append ONE `validation_escalated` row. The pre-upgrade episode
-- keeps the silence it had; the per-episode rule applies to blocks that happen from here on.
-- No other row is touched: an arm other than blocked kept its per-row rule, so nothing else
-- becomes eligible (rehearsed: the "newly eligible" count is zero after this file, on the
-- adversarial body AND on a copy of the dev box's database).
--
-- INVISIBLE ON THE DASHBOARD. The carried row takes the INSTANT and the `thread_id` of the
-- stamp it carries, so `validation_escalated_at` (the "user has been asked" label reads
-- MAX(created_at)) and `validation_thread_id` read exactly what they read before the upgrade.
-- Its position on the log (its id) is what the suppressor compares, and that is after the
-- entry. Payload: `{ thread_id, carried: 1, carried_from: <the stamp's id> }`; actor
-- `migration-189d`, so the row says where it came from.
--
-- json_valid guards every json_extract: a malformed payload must not abort the boot (189c's
-- rehearsal finding).

INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT w.id,
       'validation_escalated',
       json_object(
         'thread_id', CASE WHEN json_valid(st.payload) THEN json_extract(st.payload, '$.thread_id') END,
         'carried', 1,
         'carried_from', st.id),
       'migration-189d',
       st.created_at
  FROM work w
  JOIN work_events st
    ON st.id = (SELECT MAX(s.id) FROM work_events s
                 WHERE s.work_id = w.id AND s.kind = 'validation_escalated')
 WHERE w.state = 'blocked'
   AND st.id < (SELECT MAX(e.id) FROM work_events e
                 WHERE e.work_id = w.id AND e.kind = 'transition'
                   AND CASE WHEN json_valid(e.payload)
                            THEN json_extract(e.payload, '$.to') END = 'blocked');
