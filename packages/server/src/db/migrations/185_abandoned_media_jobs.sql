-- 185 (t122): THE MEDIA JOB ROWS ALREADY ABANDONED ON AN UPGRADED BOX ARE CLOSED, ONCE.
--
-- ── WHAT WENT WRONG ──
-- `generation_jobs` (migration 063) and `video_jobs` (migration 062) have carried non-terminal
-- rows for as long as either table has existed. A crash mid-render, a kill -9, a self-update
-- that landed while a narration was queued: the row stays `queued` / `running` / `polling` for
-- ever, because the process that owned it is gone and no later process claims it. That was
-- harmless for as long as nothing READ those rows.
--
-- Then `agent/live-work.ts` started reading them, to answer "is there anything a stop would cut
-- for this agent" — which is the right question asked of the right facts, and the reason the
-- rows were never true came due all at once. One abandoned row makes its agent offer a stop
-- control permanently, on an agent whose own status correctly reads `idle`. The owner saw it on
-- agent after agent within minutes of an upgrade. Nothing was running; the rows merely said so.
--
-- ── THE CODE HALF, AND WHY THIS FILE IS NOT THE SAME CHANGE TWICE ──
-- The root fix is `packages/server/src/services/job-orphans.ts`, called once per boot from
-- `index.ts` step 4m-0 before either job adopter starts, which makes the state structurally
-- impossible from here on. This file is the other half, and the two are NOT redundant:
--
--   * It dates the repair into the upgrade record (`_migrations` + its checksum), so a body
--     that comes up with clean job rows has evidence of WHY rather than coincidence.
--   * It is the ONLY repair for an IMPORTED body. `gateway/routes/migration.ts`'s import door
--     calls `runMigrations()` inside a LIVE process whose boot reconciliation has already fired
--     and will refuse to fire again (correctly — by then real jobs exist in that process). Every
--     job row in an imported body belongs to the other machine's dead processes. Without this
--     file they would stay open until the next restart, which on a box that is never restarted
--     is for ever.
--
-- ── WHAT IT TOUCHES, PRECISELY ──
--   * a `generation_jobs` row in any NON-terminal status          -> status='failed' + reason
--   * a `video_jobs` row in any NON-terminal status AND carrying
--     no `provider_job_id`                                       -> status='failed' + reason
--   * a `video_jobs` row in a non-terminal status that DOES carry
--     a `provider_job_id`                                        -> UNTOUCHED (see below)
--   * any row already `succeeded` / `failed` / `cancelled`        -> UNTOUCHED, including its
--                                                                   existing `error` text
--   * every other table                                          -> UNTOUCHED
--
-- NOTHING IS DELETED. A row the owner can still find, reading `failed` with a reason that names
-- what happened to it, is the difference between a defect fixed and evidence destroyed. The
-- reason string is the same one the boot reconciliation writes, so the two halves are one fact
-- in the database and not two dialects of it.
--
-- ── WHY A VIDEO ROW WITH A PROVIDER JOB ID IS LEFT ALONE ──
-- Migration 062's contract is that a `video_jobs` row deliberately OUTLIVES a restart, so the
-- provider's render — up to ten minutes of work the owner has already paid for — is not
-- abandoned with the process that submitted it. `startVideoJobPoller` adopts every `queued` /
-- `polling` row on the way up and drives it to a terminal state. Those rows HAVE an owner.
-- Failing them here would re-create exactly the defect t114 (U4) measured: `failed` is terminal
-- and the boot resume skips it, so the asset is never fetched and the owner is billed for a
-- video they never see. A row with NO `provider_job_id` is the opposite case — no remote render
-- was ever acknowledged, so there is nothing to poll and no worker will ever be made for it.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- It is not destructive and it cannot over-reach: both predicates are keyed on the TERMINAL
-- status set, which a row cannot leave, so a finished job of any age is protected by its own
-- status and a successful render's `asset_path`, `cost_usd` and `error` are never rewritten. It
-- touches no other table, has no foreign-key consequence (nothing references either table), and
-- cannot RAISE — no JSON function, no CHECK re-evaluated by an update, no parse of any column
-- value — so it is not the `.23` / `135` class. A fresh install applies it against empty tables
-- and is correct: it has abandoned nothing.
--
-- THE STATUS VOCABULARY IS READ FROM THE TERMINAL END, deliberately. Measured across every
-- writer of either table at this head, `generation_jobs` ∈ {queued, running, succeeded, failed,
-- cancelled} and `video_jobs` ∈ {queued, polling, succeeded, failed, cancelled} — the open sets
-- differ, the terminal set is identical. An enumerated OPEN end is the shape that caused this
-- defect: a reader or sweep written against it is blind to any word added later. Asked from the
-- terminal end, an unrecognised status means "something is open", which gets swept here and
-- counted by `live-work.ts` rather than silently believed. `services/media-job-status.ts` holds
-- the same census for the code half.
--
-- IDEMPOTENT BY ITS PREDICATE, not by the `_migrations` marker: after the first pass every
-- matching row is `failed`, so a second pass matches nothing. The marker is the optimisation;
-- the WHERE is the safety.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITERS of the reason string: this file, once, and `services/job-orphans.ts` from here on.
-- READERS of the rows it closes: `agent/live-work.ts` (the stop predicate), the two job lists in
-- `gateway/routes/config.ts`, and the dashboard's jobs indicator — all of which want exactly
-- this answer. Guarded by `db/__tests__/migration-185-abandoned-media-jobs.test.ts` and
-- `services/__tests__/an-abandoned-job-row-does-not-fake-live-work.test.ts`.

-- (1) Run-once media jobs: nothing can ever adopt one across a process boundary.
UPDATE generation_jobs
   SET status = 'failed',
       error = 'abandoned at boot: no owning process',
       finished_at = datetime('now'),
       updated_at = datetime('now')
 WHERE status NOT IN ('succeeded', 'failed', 'cancelled');

-- (2) Video jobs: only the ones the boot poller cannot adopt, i.e. those with no provider
--     render behind them. A row with a provider job id is left for the poller on purpose.
UPDATE video_jobs
   SET status = 'failed',
       error = 'abandoned at boot: no owning process',
       finished_at = datetime('now'),
       updated_at = datetime('now')
 WHERE status NOT IN ('succeeded', 'failed', 'cancelled')
   AND (provider_job_id IS NULL OR trim(provider_job_id) = '');
