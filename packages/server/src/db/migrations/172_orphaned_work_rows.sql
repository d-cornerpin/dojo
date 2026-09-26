-- 172 (BACKLOG WAVE-1A): THE WORK ROWS EVERY PREVIOUS PURGE LEFT BEHIND ARE SWEPT ONCE.
--
-- ── WHAT WENT WRONG ──
-- `work.agent_id` carries NO foreign key and NO cascade, and that is deliberate: migration 135's
-- PART 0 rider 1 keeps a work row readable after its agent is gone, so the spine's history
-- survives a deletion. The consequence nobody closed is that NOTHING deleted those rows either.
-- `POST /api/agents/:id/purge` sweeps seven tables by hand — messages, the agent bus, summaries
-- and their two link tables, context items, large files, audit log — and walked straight past the
-- work spine. So every agent ever purged on every box left its work rows behind, including rows
-- in state `on_deck`, which is the state the scheduler's 30-second poll selects on: a timer still
-- armed for an agent that cannot run.
--
-- The code half of the fix is `deleteAllWorkForAgent()` in `packages/server/src/work/purge-sweep.ts`,
-- called by the purge door. This file is the other half, and the two are one change: ship the
-- door fix alone and every row already orphaned on the owner's box — and on every stable box —
-- stays there forever, because nothing revisits a purge that already happened.
--
-- MEASURED ON THE OWNER'S BODY BEFORE THIS LANDED: 18 orphaned `work` rows (6 `abandoned`,
-- 8 `done`, 4 `failed`) across 9 vanished agents, carrying 78 `work_events` and 0
-- `adjudications`. The backlog entry that opened this said "two orphaned on_deck rows"; by the
-- time it was worked there were none in `on_deck` — those two had already been fired or
-- abandoned by the scheduler, which is a worse outcome than a stuck timer and is why the sweep
-- is not restricted to that state.
--
-- ── WHAT IT TOUCHES, PRECISELY ──
--   * a `work` row whose `agent_id` matches no row in `agents`        -> DELETED
--   * `work_events` / `adjudications` hanging off such a row          -> DELETED with it
--   * `techniques.build_project_id` pointing at such a row           -> set NULL (a technique
--                                                                       outlives the project that
--                                                                       built it; the column is
--                                                                       nullable for this reason)
--   * `work.parent_id` pointing INTO the doomed set                  -> set NULL
--   * a `work` row whose agent EXISTS, in any state                  -> UNTOUCHED
--   * every other table                                              -> UNTOUCHED
--
-- ── THE ORDER IS FK-DRIVEN, AND IT IS NOT ONLY FOR THIS FILE'S BENEFIT ──
-- Three things reference `work(id)`, all `NO ACTION`: `work_events.work_id`,
-- `adjudications.work_id`, `techniques.build_project_id`, plus `work.parent_id` referencing
-- ITSELF. `runSqlMigrations` turns `foreign_keys` OFF for the whole chain, so this file could
-- ignore all four and still apply — which is exactly why it does not. Deleting a parent while a
-- child still names it would leave a DANGLING reference that the next `PRAGMA foreign_key_check`
-- reports and that the running server (FKs ON) then trips over. The nulling statements run first
-- so that after this file no row anywhere points at a row it deleted. 4 parent/child pairs exist
-- among the live orphans, so this is load-bearing, not hypothetical.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- It is DESTRUCTIVE — it says so plainly — but only of rows that are already unreachable. A
-- `work` row whose `agent_id` names no agent cannot be listed, claimed, transitioned, scheduled
-- or delivered: every reader in the spine is agent-scoped (`work/store.ts`, `tracker-view.ts`,
-- `scheduler/runner.ts`), and an agent that does not exist is never the subject of a read. So the
-- rows carry no answer anybody can reach, and the history argument that justifies the missing
-- cascade — "a report about what that agent hit is still a true record" — applies to a DELETED
-- agent's own record, which a purge has already destroyed on purpose.
--
-- It cannot over-reach: the predicate is a `LEFT JOIN agents ... WHERE a.id IS NULL`, so a single
-- surviving `agents` row protects every work row that names it. It cannot RAISE — no JSON
-- function, no CHECK re-evaluated by a delete, no parse of any column value — so it is not the
-- `.23`/`135` class. It is not the `139` class (final when it ships), and not a `<NNN>b` bridge
-- file, so the string-sort caveat does not apply.
--
-- IDEMPOTENT BY ITS PREDICATE, not by the `_migrations` marker: after the first run no orphan
-- matches, so a second run deletes nothing. The marker is the optimisation; the WHERE is the
-- safety.
--
-- A fresh install applies it against empty tables and is correct: it has purged nothing.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITER: this file, once, plus `work/purge-sweep.ts`'s `deleteAllWorkForAgent()` from here on (called
-- only by `gateway/routes/agents.ts`'s purge door). READERS of the rows it removes: none — that
-- is the finding. The pairing is guarded by
-- `db/__tests__/migration-172-orphaned-work-rows.test.ts` and by
-- `gateway/routes/__tests__/a-purge-takes-the-work-with-it.test.ts`, whose seeded-agent clause
-- goes red if the door stops calling the sweep.

-- (1) Events of the doomed rows.
DELETE FROM work_events
 WHERE work_id IN (SELECT w.id FROM work w LEFT JOIN agents a ON a.id = w.agent_id WHERE a.id IS NULL);

-- (2) Adjudications of the doomed rows.
DELETE FROM adjudications
 WHERE work_id IN (SELECT w.id FROM work w LEFT JOIN agents a ON a.id = w.agent_id WHERE a.id IS NULL);

-- (3) A technique keeps existing without the project that built it.
UPDATE techniques SET build_project_id = NULL
 WHERE build_project_id IN (SELECT w.id FROM work w LEFT JOIN agents a ON a.id = w.agent_id WHERE a.id IS NULL);

-- (4) Nothing may still name a row about to go — including the doomed set's own children.
UPDATE work SET parent_id = NULL
 WHERE parent_id IN (SELECT w.id FROM work w LEFT JOIN agents a ON a.id = w.agent_id WHERE a.id IS NULL);

-- (5) The rows themselves.
DELETE FROM work
 WHERE id IN (SELECT w.id FROM work w LEFT JOIN agents a ON a.id = w.agent_id WHERE a.id IS NULL);
