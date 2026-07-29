-- 144_task_runs_absorbed.sql — PHASE-2 T10F: the scheduler's run bookkeeping stops being a
-- second table, and the runs that never became occurrence rows are rescued before it goes.
--
-- ┌─ task_runs ────────────────────────────────────────────────────────────────────────────┐
-- │ VERDICT: STRIP.                                                                        │
-- │                                                                                        │
-- │ requirement preserved: THE OWNER'S RUN HISTORY for a scheduled task — run number, the   │
-- │ instant it was for, when it started and finished, its status, who ran it, and what it   │
-- │ said — plus the four pieces of bookkeeping that kept it honest (close-once, the two     │
-- │ orphan sweeps, and the fallen path's skipped-run count).                                │
-- │                                                                                        │
-- │ It is `work(kind='occurrence')` with `parent_id` = the schedule and `sequence` = the run │
-- │ number, projected by `work/occurrence-runs.ts` and written by `work/occurrences.ts`.     │
-- │ Every field the dashboard renders and every sweep is a clause in                         │
-- │ `work/__tests__/occurrence-runs.test.ts` (29), all RED before the projection existed.    │
-- │                                                                                        │
-- │ WHY THIS IS NOT A CUTOVER: the replacement was BUILT AT PHASE-2 T8c2 (item 4) AND THE   │
-- │ PREDECESSOR WAS NOT DELETED. `scheduler/runner.ts` claimed an occurrence at `:729` and  │
-- │ then INSERTed a `task_runs` row at `:747`; it settled the occurrence at `:931` and      │
-- │ UPDATEd `task_runs` at `:911`. Two records of one fact, written by one function, on     │
-- │ every fire. This file removes the second one. That is the disease this phase exists for,│
-- │ observed in its purest form.                                                            │
-- │                                                                                        │
-- │ evidence, re-derived at THIS head by command, non-test and non-migration across         │
-- │ `packages/server/src`, `packages/dashboard/src` AND `watchdog/`:                         │
-- │   grep -rnaE "(FROM|INTO|UPDATE|JOIN|TABLE)[[:space:]]+task_runs\b|DELETE FROM task_runs\b"
-- │   -> 18 before this task, 0 after. The 4 surviving mentions are comments naming what     │
-- │   was replaced.                                                                          │
-- │                                                                                          │
-- │ AND THE ROW COUNT IS NOT THE EVIDENCE — this table is non-negotiable #15's own worked    │
-- │ example ("0 rows -> the feature is dead" is listed there as a false verdict this project │
-- │ already made once). `/api/tasks/:taskId/runs` is MOUNTED (`gateway/server.ts:280`) and   │
-- │ its consumer is LIVE (`dashboard/src/components/TaskRunHistory.tsx`, rendered from       │
-- │ `pages/Tracker.tsx:278`). The projection is what makes this a STRIP; without it this     │
-- │ would be a drop that blanked a panel the owner opens.                                    │
-- │                                                                                          │
-- │ NOTHING REFERENCES IT: `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE   │
-- │ '%REFERENCES%task_runs%'` returns EMPTY, so no table rebuild is owed.                    │
-- │ this box: 2 rows, and see the rescue below — they are not equally represented.           │
-- └────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ── THE RESCUE, AND WHY IT IS NOT OPTIONAL ──
--
-- Measured on this box before this file was written, NOT assumed:
--
--   SELECT tr.id, tr.run_number, tr.status,
--          EXISTS(SELECT 1 FROM work w WHERE w.kind='occurrence'
--                  AND w.parent_id=tr.task_id AND w.sequence=tr.run_number) AS has_occurrence
--     FROM task_runs tr;
--   ->  aef03ece… run 1 complete  has_occurrence 0
--       10f2e52d… run 1 failed    has_occurrence 1
--
-- So ONE of the two rows has an occurrence twin and one does not: the occurrence writer only
-- started at T8c2, and every run fired before it exists in `task_runs` alone. Dropping the
-- table on the "0 statements" evidence would have silently blanked that task's run history —
-- the same class of loss the D1 rider names for `agent_messages` ("rescue its rows, or leave
-- the table alone. Do not drop it empty-handed").
--
-- THE MAPPING, field by field, with the two places it cannot be verbatim:
--
--   id             -> id            (carried, so any surviving `messages.run_id` still resolves)
--   task_id        -> parent_id + requester_id + root_id   (root_kind='schedule')
--   run_number     -> sequence      (`ux_work_occurrence` makes it unique per schedule)
--   scheduled_for  -> next_run_at   (epoch ms; the instant the run was FOR)
--   started_at     -> opened_at     (falling back to created_at, then the parent's opened_at)
--   completed_at   -> closed_at     (terminal rows only — a paired-nullability CHECK)
--   assigned_to    -> agent_id + assignee_agent
--   result_summary -> notes         (`error` folded in: it was only ever written by the
--                                    no-agent skip, and its text was the same sentence)
--   status         -> state, AND an `occurrence_settled` event carrying the ORIGINAL WORD
--
--   (1) `status='complete'` becomes `state='abandoned'`, NOT `done`. G7 is a DB CHECK — `done`
--       is unreachable without a `result_delivery_id` — and no sentinel delivery is invented
--       to pretend a rescued run delivered something. The history still reads "complete",
--       because the `occurrence_settled` event carries `run_status`, which is exactly the
--       discriminator `work.state` cannot hold. Same mechanism the live settle uses.
--   (2) `tokens_used` and `cost_usd` are DROPPED, and that is a measurement: no production
--       statement ever wrote either (the only mentions of those names anywhere are
--       `cost_records`, a different table), and both were NULL in every row on this box.
--       A column with no writer and no value is not a preserved fact.
--
-- TWO CLASSES ARE DELIBERATELY NOT RESCUED, and the file says so rather than filtering
-- silently:
--   * a run whose schedule is gone from `work` — `parent_id REFERENCES work(id)` would refuse
--     it, and a run pointing at a deleted schedule is a pointer to deleted data, not a
--     preserved fact (the same call `142` made for `techniques.build_project_id`). 0 on this
--     box.
--   * a run whose `(schedule, run_number)` already HAS an occurrence row — the occurrence is
--     the live record and rescuing beside it would create the double history this file exists
--     to remove. 1 on this box.
--
-- provenance='rescued' is stamped on every rescued row, so "this history came from the old
-- table" stays answerable by query rather than by memory. The column's CHECK already admits
-- the value (migration `135`).
--
-- ── RE-RUNNABLE: NO, AND MY FIRST DRAFT OF THIS LINE SAID YES ──
--
-- The rehearsal is what corrected it, not review. This file's first header claimed
-- "re-runnable: YES — the rescue is INSERT ... WHERE NOT EXISTS, the drop is IF EXISTS", which
-- reads true and is FALSE ON CONTACT: the rescue SELECTs `FROM task_runs`, so once step 3 has
-- dropped the table a second apply fails with `no such table: task_runs`. Measured on all
-- three bodies.
--
-- It is NOT repaired, because failing is the right direction and `143` already made this call
-- for the same reason: `applyOne` records the migration's name INSIDE the same transaction as
-- the apply, so a crash rolls back the rescue, the drop and the bookkeeping together, and a
-- retry finds the table present and does the whole thing once. What is left is a MANUAL
-- re-run, and after MAP-TRIAGE the right behaviour for that is to fail loudly rather than to
-- succeed silently against a body it was not written for.
--
-- Destructive: YES, deliberately. On a lived-in box these rows are preserved by
-- `135b_stable_work_spine.sql`, which sorts strictly BEFORE this file — the same ordering
-- argument Bridge Entries 13 and 16 make. A box running the local chain WITHOUT the Bridge
-- loses them, which on a developer or preflight box is correct.

-- ── 1. Rescue the runs that never became occurrence rows ──────────────────────────────────

INSERT INTO work (
  id, kind, parent_id, agent_id, assignee_agent, requester, requester_id,
  root_kind, root_id, state, intent, wakes, closes_thread,
  title, sequence, next_run_at, notes, opened_at, closed_at, updated_at, provenance
)
SELECT
  tr.id,
  'occurrence',
  tr.task_id,
  COALESCE(tr.assigned_to, 'scheduler'),
  tr.assigned_to,
  'schedule',
  tr.task_id,
  'schedule',
  tr.task_id,
  CASE tr.status
    WHEN 'failed'  THEN 'failed'
    WHEN 'complete' THEN 'abandoned'   -- G7: no delivery to point at, so NOT `done`
    WHEN 'skipped' THEN 'abandoned'
    ELSE 'open'                        -- 'pending' / 'running': still in flight
  END,
  'occurrence', 0, 0,
  'occurrence #' || tr.run_number,
  tr.run_number,
  CAST(strftime('%s', tr.scheduled_for) AS INTEGER) * 1000,
  COALESCE(tr.result_summary, tr.error),
  -- opened_at: the instant it started, then the instant the row was created, then the
  -- schedule's own opening instant. The CHECK requires > 1600000000000, and the fallback
  -- chain is what guarantees a value rather than a failed migration on a sparse old row.
  COALESCE(
    CAST(strftime('%s', tr.started_at) AS INTEGER) * 1000,
    CAST(strftime('%s', tr.created_at) AS INTEGER) * 1000,
    p.opened_at
  ),
  -- closed_at: NON-NULL exactly when the state is terminal, which is a paired-nullability
  -- CHECK on `work`. A terminal run with no recorded completion instant falls back to when
  -- it started, because "it ended" is the fact and the instant is the detail.
  CASE WHEN tr.status IN ('failed', 'complete', 'skipped')
       THEN COALESCE(
              CAST(strftime('%s', tr.completed_at) AS INTEGER) * 1000,
              CAST(strftime('%s', tr.started_at) AS INTEGER) * 1000,
              CAST(strftime('%s', tr.created_at) AS INTEGER) * 1000,
              p.opened_at)
       ELSE NULL END,
  COALESCE(
    CAST(strftime('%s', tr.completed_at) AS INTEGER) * 1000,
    CAST(strftime('%s', tr.started_at) AS INTEGER) * 1000,
    CAST(strftime('%s', tr.created_at) AS INTEGER) * 1000,
    p.opened_at
  ),
  'rescued'
FROM task_runs tr
JOIN work p ON p.id = tr.task_id          -- the schedule must still exist (see above)
WHERE NOT EXISTS (
  SELECT 1 FROM work w
   WHERE w.kind = 'occurrence' AND w.parent_id = tr.task_id AND w.sequence = tr.run_number
);

-- ── 2. Carry each rescued run's OWN outcome word, so the history still reads it ───────────
--
-- `state` cannot tell "finished but delivered nothing" from "never ran" — both are
-- `abandoned`. `work/occurrence-runs.ts` resolves that from this event, exactly as it does
-- for a live settle. Only rows this file just rescued get one (`provenance='rescued'`), so a
-- re-run cannot double-write it.

INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT w.id,
       'occurrence_settled',
       json_object('run_status', tr.status, 'summary', COALESCE(tr.result_summary, tr.error),
                   'rescued_from', 'task_runs'),
       'scheduler',
       COALESCE(w.closed_at, w.opened_at)
  FROM task_runs tr
  JOIN work w ON w.id = tr.id AND w.kind = 'occurrence' AND w.provenance = 'rescued'
 WHERE tr.status IN ('failed', 'complete', 'skipped')
   AND NOT EXISTS (
     SELECT 1 FROM work_events e
      WHERE e.work_id = w.id AND e.kind = 'occurrence_settled'
   );

-- ── 3. The table goes, and its two named indexes go with it ──────────────────────────────

DROP TABLE IF EXISTS task_runs;
