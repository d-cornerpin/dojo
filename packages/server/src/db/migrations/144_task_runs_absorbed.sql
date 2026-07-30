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
-- ══════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ AMENDED PHASE-2 HOTFIX-144 (2026-07-30) — THE OLD TABLE HAD NO UNIQUENESS AND THE NEW
--   ONE DOES, SO THE RESCUE MUST DECIDE WHICH RUN OWNS THE SLOT INSTEAD OF DISCOVERING IT.
--
-- WHAT HAPPENED, and it happened on the only real box on this channel other than dev. The
-- owner's preflight server took v3.1.17-preflight.23 and this file aborted three times in a
-- row, deterministically, with
--
--     UNIQUE constraint failed: work.parent_id, work.sequence
--
-- (server log 2026-07-30T16:35:10.992Z and twice more; every attempt rolled its per-file
-- transaction back, so his box rests at `143` with `144`-`148`/`900` unapplied and NO row in
-- `_migrations` for this file). The watchdog then rolled the code back to `.22`, which errors
-- on the new schema — expected, and not this file's problem to solve.
--
-- THE DEFECT IS IN THE GUARD'S SCOPE, not in the mapping. `WHERE NOT EXISTS (… work w …)`
-- asks "does an occurrence for this slot ALREADY exist" and that is a question about the rows
-- that were there BEFORE the statement. It cannot see the rows the statement is itself
-- inserting. `task_runs` never had a uniqueness constraint on `(task_id, run_number)` — that
-- absence is the whole reason `ux_work_occurrence` exists — so two old rows for one slot both
-- answer "no", both are emitted, and the SECOND one hits the index. The dev box has one run
-- per slot and the two rehearsal bodies have zero `task_runs` rows at all, which is exactly
-- why three green rehearsals could not see this: THE BODIES LACKED THE SHAPE. #16's rehearsal
-- rule is only as good as the body, and a body without the row cannot exercise the branch.
--
-- THE MAPPING FOR A DUPLICATED SLOT, and it is a mapping rather than a filter (#15 — a
-- duplicate is real history, not noise):
--
--   * THE EARLIEST RUN KEEPS THE OCCURRENCE SLOT. "Earliest" is the same ladder the rescue
--     already uses to date a run — `started_at`, then `created_at`, then `scheduled_for` —
--     with unreadable instants sorted LAST (they cannot be shown to be earlier) and `id` as
--     the final tiebreak so the choice is deterministic on a re-run and on any box.
--   * EVERY OTHER RUN FOR THAT SLOT IS KEPT AS A `work_events` ROW OF KIND `audit` ON THE
--     OCCURRENCE THAT HOLDS THE SLOT, carrying all nine of its fields verbatim. That is the
--     honest shape: these ARE the retry history of one occurrence — one execution slot fired
--     more than once — and #15 forbids resolving that by deletion. They are NOT second
--     occurrence rows, because `ux_work_occurrence` says one occurrence is one execution and
--     this file exists to make that true rather than to route around it.
--   * `kind='audit'` is chosen for the reason `146` chose it and RULING 10 argued: an audit
--     line must never be able to answer a LIVE PREDICATE. `occurrence-runs.ts` resolves a
--     run's outcome word from `work_events` scoped `e.kind = 'occurrence_settled'`
--     (`occurrence-runs.ts:81-83`, read at this head), so an `audit` row is invisible to it
--     by construction and the projected run history is unchanged. `kind='audit'` is read by
--     `work/audit-trail.ts` and nowhere else — its own header says so and this file relies on
--     it. `entry_kind='task_run_duplicate'` inside the payload names what the row is.
--
-- TWO MORE ROWS JOIN THAT SAME AUDIT DISPOSITION, because once the machinery exists there is
-- no argument for treating them worse:
--
--   * THE RUN WHOSE SLOT A LIVE OCCURRENCE ALREADY HOLDS (1 on the dev box). The paragraph
--     above still stands — the occurrence is the live record and this file will not rescue a
--     twin beside it — but the ORIGINAL WORDING let the old row's status and summary go with
--     the table, which is a drop resting on "something better exists" rather than on a
--     preservation. It now lands as an `audit` row on that live occurrence, so the fact
--     survives and the live record is still the only occurrence.
--   * THE RUN WHOSE `id` IS ALREADY A `work` ID. Structurally impossible to rescue (`work.id`
--     is the PRIMARY KEY) and this is a GUARD BY CONSTRUCTION, not a measurement: 0 such rows
--     anywhere we can see. It is one clause, it converts a would-be second abort of the whole
--     chain into a preserved audit row, and the rehearsal plants it so the branch is
--     exercised rather than merely asserted.
--
-- The one class that is still NOT rescued is unchanged and is still argued rather than
-- filtered: a run whose SCHEDULE is gone from `work` has no work row to hang anything on, and
-- a pointer to deleted data is not a preserved fact (`142`'s precedent). 0 on every body.
--
-- ── AND A SECOND DEFECT OF THE SAME CLASS, FOUND BY SWEEPING RATHER THAN BY FAILING ──
--
-- `opened_at` carries `CHECK (opened_at > 1600000000000)` and the ladder below fed it
-- whatever `strftime` returned. A COALESCE ladder handles an UNREADABLE instant and NOT a
-- READABLE one below the floor: `strftime('%s','1999-01-01 00:00:00')` is 915148800, converts
-- to 915148800000, fails the CHECK, and aborts this file — which on a real box aborts the
-- chain and therefore the BOOT. This is RULING 12's finding verbatim, one file later:
-- migration `135` was amended for it at T13 and `144` was not swept for it then. The two
-- `opened_at` expressions are now `MAX(…, 1600000000001)`, the same sentinel and the same
-- argument. `closed_at` and `updated_at` are deliberately NOT clamped — neither carries a
-- CHECK, and rewriting a readable historical instant the schema CAN store would falsify it.
--
-- ── WHY AMENDING THIS FILE IS THE FIX, AND WHY THAT IS SAFE ──
--
-- Amending a SHIPPED migration is normally forbidden — `migration-checksums.ts` exists
-- because of what it does to boxes that already ran it. This file has NOT been run to
-- completion anywhere it matters, and that premise was re-derived from the evidence rather
-- than inherited: the owner's log shows three `Migration failed: 144_task_runs_absorbed.sql`
-- lines and ZERO `Migration applied`, and `applyOne` records the name inside the same
-- transaction as the apply, so his `_migrations` has no `144` row and his next boot runs
-- whatever this file says. Nothing was pushed and no other box has the chain. The ONE box
-- that did apply it is this dev box, whose recorded checksum now describes the old bytes; its
-- boot audit will read `diverged 1` for `144` until that row is re-recorded, which is a
-- deliberate, documented act on a rebuildable box and not a manufactured agreement (contrast
-- `135`, where the re-record was proven NOT owed because that row carries no checksum at all).
-- A NEW migration number would not work here: `144` never committed on his box, so a `149`
-- would still have to let the broken `144` run first.
-- ══════════════════════════════════════════════════════════════════════════════════════════
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

-- ── 1. DECIDE THE SLOT ONCE, IN A TABLE, INSTEAD OF DISCOVERING IT MID-STATEMENT ──────────
--
-- The same instrument `147` uses and for the same reason: a condition that has to be true
-- ACROSS the rows of one statement cannot be asked of the rows that statement is inserting.
-- Resolving into a temp table makes "which run owns this slot" a computed fact that both the
-- rescue and the audit carry-over read, so the two can never disagree.
--
-- `_mig144_cand` is every run this file is ALLOWED to rescue: a live schedule to hang it on,
-- a slot no existing occurrence already holds, and an `id` free in `work`. `ord_ms` is when
-- the run happened, by the rescue's own dating ladder.

DROP TABLE IF EXISTS _mig144_cand;
CREATE TEMP TABLE _mig144_cand AS
SELECT tr.id                              AS run_id,
       tr.task_id                         AS task_id,
       tr.run_number                      AS run_number,
       COALESCE(
         CAST(strftime('%s', tr.started_at)     AS INTEGER) * 1000,
         CAST(strftime('%s', tr.created_at)     AS INTEGER) * 1000,
         CAST(strftime('%s', tr.scheduled_for)  AS INTEGER) * 1000
       )                                  AS ord_ms
  FROM task_runs tr
  JOIN work p ON p.id = tr.task_id        -- the schedule must still exist (see the header)
 WHERE NOT EXISTS (
         SELECT 1 FROM work w
          WHERE w.kind = 'occurrence' AND w.parent_id = tr.task_id
            AND w.sequence = tr.run_number)
   AND NOT EXISTS (SELECT 1 FROM work w2 WHERE w2.id = tr.id);

-- The winner is rn = 1: earliest first, unreadable instants last (an instant that cannot be
-- read cannot be shown to be earlier), `id` as the deterministic final tiebreak.
DROP TABLE IF EXISTS _mig144_slot;
CREATE TEMP TABLE _mig144_slot AS
SELECT run_id, task_id, run_number, ord_ms,
       row_number() OVER (PARTITION BY task_id, run_number
                          ORDER BY (ord_ms IS NULL), ord_ms, run_id) AS rn
  FROM _mig144_cand;
CREATE INDEX _mig144_slot_run ON _mig144_slot(run_id);

-- ── 2. Rescue the runs that never became occurrence rows ──────────────────────────────────

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
  -- CLAMPED at HOTFIX-144 (RULING 12's idiom, `135`'s sentinel): the ladder answers an
  -- UNREADABLE instant, and a READABLE pre-2020 one would pass the ladder and fail the CHECK.
  MAX(COALESCE(
    CAST(strftime('%s', tr.started_at) AS INTEGER) * 1000,
    CAST(strftime('%s', tr.created_at) AS INTEGER) * 1000,
    p.opened_at
  ), 1600000000001),
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
JOIN _mig144_slot s ON s.run_id = tr.id AND s.rn = 1;   -- one occurrence, one execution

-- ── 3. Carry each rescued run's OWN outcome word, so the history still reads it ───────────
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

-- ── 4. THE RUNS THAT DID NOT TAKE A SLOT ARE KEPT, AS AUDIT ROWS ON THE ONE THAT DID ─────
--
-- Three populations arrive here and the header argues each: a later duplicate of a slot this
-- file just filled, a run whose slot a LIVE occurrence already held, and a run whose `id` was
-- already a `work` id. None of them may become a second occurrence row — that is the
-- constraint this whole file exists to honour — and none of them may be dropped, because a
-- retry that really happened is history (#15).
--
-- The target is the occurrence that HOLDS the slot, falling back to the schedule itself. Both
-- are existing `work` rows: the fallback's row is the `p` this SELECT joins, so `work_id`
-- always resolves and the branch is total. `kind='audit'` keeps these out of every live
-- predicate — see the header, and `occurrence-runs.ts:81-83` for the scoping that makes it so.
--
-- `created_at` is NOT clamped: `work_events` carries no CHECK on it, and the ladder already
-- ends at `p.opened_at`, which is NOT NULL by `work`'s own schema.

INSERT INTO work_events (work_id, kind, payload, actor, created_at)
SELECT COALESCE(
         (SELECT w.id FROM work w
           WHERE w.kind = 'occurrence' AND w.parent_id = tr.task_id
             AND w.sequence = tr.run_number
           ORDER BY w.id LIMIT 1),
         tr.task_id),
       'audit',
       json_object(
         'entry_kind',     'task_run_duplicate',
         'run_id',         tr.id,
         'run_number',     tr.run_number,
         'run_status',     tr.status,
         'scheduled_for',  tr.scheduled_for,
         'started_at',     tr.started_at,
         'completed_at',   tr.completed_at,
         'assigned_to',    tr.assigned_to,
         'summary',        COALESCE(tr.result_summary, tr.error),
         'rescued_from',   'task_runs',
         'provenance',     'rescued'),
       COALESCE(tr.assigned_to, 'scheduler'),
       COALESCE(
         CAST(strftime('%s', tr.started_at)    AS INTEGER) * 1000,
         CAST(strftime('%s', tr.created_at)    AS INTEGER) * 1000,
         CAST(strftime('%s', tr.scheduled_for) AS INTEGER) * 1000,
         p.opened_at)
  FROM task_runs tr
  JOIN work p ON p.id = tr.task_id
 WHERE NOT EXISTS (SELECT 1 FROM _mig144_slot s WHERE s.run_id = tr.id AND s.rn = 1);

-- ── 5. The table goes, and its two named indexes go with it ──────────────────────────────

DROP TABLE IF EXISTS task_runs;
DROP TABLE IF EXISTS _mig144_slot;
DROP TABLE IF EXISTS _mig144_cand;
