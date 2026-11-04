-- 210 (v3.5 field fix 3, #3): A FINISHED ROW IS NOT AWAITING THE OWNER'S VERDICT.
--
-- WHAT WAS LEFT ON A BOX. Until this build only four callers ever cleared a
-- `user_verdict_requested` (the stale sweep, override approve, apply-user-verdict and the
-- dashboard override route). A row finished any other way (a cancel, a bulk close, an owner
-- drag, the PM) kept its request "open" on the log. The 12h sweep then picked it every 30s,
-- its drop to blocked was refused (a finished row only goes back to open), and it wrote a false
-- "dropped to blocked, please review" line and two board broadcasts anyway: 716 per task in six
-- hours on the owner's box, five tasks.
--
-- From this build a move into a terminal state answers the request in the same transaction
-- (`work/store.ts:transition`), and `awaitingUserVerdictExpr` excludes terminal rows. This file
-- repairs the rows finished BEFORE it: for each row in a terminal state whose newest request is
-- newer on the log than its newest clear, append ONE `user_verdict_cleared`. Append-only:
-- nothing is updated or deleted, so the false `auto_sweep` rows stay as the record of what the
-- old sweep wrote (whether to prune them is the owner's call). A live row's request is the
-- owner's to answer and is not touched. Running it again appends nothing, since no finished
-- row is left with a request open. Actor `migration-210`, so the row says where it came from.

INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT w.id,
       'user_verdict_cleared',
       json_object('reason', 'closed: ' || w.state || ' (the request was left open when the row finished)'),
       'migration-210',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM work w
 WHERE w.state IN ('done', 'failed', 'abandoned')
   AND COALESCE((SELECT MAX(q.id) FROM work_events q WHERE q.work_id = w.id AND q.kind = 'user_verdict_requested'), -1)
     > COALESCE((SELECT MAX(c.id) FROM work_events c WHERE c.work_id = w.id AND c.kind = 'user_verdict_cleared'), -1);
