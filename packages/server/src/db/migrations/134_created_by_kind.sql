-- 134_created_by_kind.sql — PHASE-1 T11 Step 1b (the K8 rider): harness ownership
-- becomes STRUCTURAL instead of a name pattern.
--
-- THE DEFECT THIS CLOSES, measured rather than argued. The behavioral harness's
-- clean-slate sweep decides what it may delete by matching agent NAMES:
--
--     SELECT id FROM agents WHERE name LIKE 'Behav%' OR name LIKE 'behavpeer%'
--
-- K8 already removed the worse half of that (a free-text LIKE over task TITLES, which
-- made any real task mentioning "harness-" deletable by a test run — the 2026-07-22
-- scalpel directive, violated harder than the debris it swept). What survived is the
-- agent-name prong, and it is wrong in both directions:
--   * a fixture rename, or a peer whose name a scenario builds differently, drops out of
--     the sweep and its debris accumulates — the Phase-0 exit left three terminated
--     `behavpeer-*` agents behind for exactly this reason (measured on this box today:
--     3 rows, all status='terminated');
--   * a lived-in agent a person happens to name "Behaviour review" matches `Behav%` and
--     its tasks and projects are inside a test run's blast radius.
--
-- Ownership is a FACT ABOUT WHO CREATED THE ROW. Free text never is. So the fact gets a
-- column, stamped once at creation by the code that does the creating, and the sweep
-- asks that column instead of guessing from a name.
--
-- THE THREE VALUES, and why exactly three:
--   'user'    — a person made this (the dashboard create form, the setup flow).
--   'agent'   — an agent or the platform itself made it (spawner, PM, technique trainer).
--   'harness' — the behavioral test kit made it, and it is disposable BY CONSTRUCTION.
-- The enum is CHECK-constrained: a fourth value is a design decision, not a typo, and it
-- should have to be written down here.
--
-- NULLABLE, DELIBERATELY, AND R1 DEPENDS ON IT. Every row that exists today predates the
-- column and reads NULL; nothing is backfilled, and nothing may be inferred from NULL
-- (roadmap #15 — an absence is not evidence). A legacy-form INSERT that names none of
-- these columns still PERSISTS rather than being refused, which is R1's whole mechanism.
-- The sweep is written to match `= 'harness'` positively, so NULL is never swept.
--
-- SQLite note: ADD COLUMN does not rewrite existing rows, so the CHECK is evaluated on
-- write only. `NULL IN ('user','agent','harness')` evaluates to NULL, not false, and a
-- CHECK passes on anything that is not false — so the existing rows are legal by the same
-- rule that lets them stay unwritten. Rehearsed on a VACUUM INTO copy before this ran.
--
-- WHERE THE READER LIVES, said plainly because the orphan gate will ask (T13 Step 1).
-- The consumer of `created_by_kind='harness'` is `dojo-test-kit`'s clean-slate sweep and
-- its per-run teardown — deliberately OUTSIDE this repository, because a test harness
-- that lived inside the tree it tests could be edited to agree with a break. The kit
-- carries its own selftest asserting the sweep reads this column
-- (`behavioral/__selftest__/harness-ownership-selftest.mjs`), the same pattern T10 used
-- for the rowid projection rule: the rule is enforced where the dojo's own walk cannot
-- reach. It is therefore NOT declared in spine-manifest.json — declaring it would
-- manufacture a guaranteed zero-reader report whose only fix is a waiver, spending one of
-- five on a structure that is working exactly as designed.

ALTER TABLE agents   ADD COLUMN created_by_kind TEXT CHECK (created_by_kind IN ('user', 'agent', 'harness'));
ALTER TABLE tasks    ADD COLUMN created_by_kind TEXT CHECK (created_by_kind IN ('user', 'agent', 'harness'));
ALTER TABLE projects ADD COLUMN created_by_kind TEXT CHECK (created_by_kind IN ('user', 'agent', 'harness'));

-- The sweep's shape, so the index earns its keep: "everything one kind created".
CREATE INDEX IF NOT EXISTS idx_agents_created_by_kind   ON agents(created_by_kind);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by_kind    ON tasks(created_by_kind);
CREATE INDEX IF NOT EXISTS idx_projects_created_by_kind ON projects(created_by_kind);
