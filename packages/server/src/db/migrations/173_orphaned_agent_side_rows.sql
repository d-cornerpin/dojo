-- 173 (BACKLOG LANE-1): THE ROWS THAT OUTLIVED THE AGENT AND THE WORK THEY BELONGED TO.
--
-- Companion to `172_orphaned_work_rows.sql`, which swept the `work` rows a purge left behind.
-- This sweeps the rest of the same damage: side rows naming an agent that no longer exists, and
-- `work_events` naming a `work` row that no longer exists.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ WHERE THE ORPHANS CAME FROM — MEASURED, because the obvious answer is WRONG.
--
-- The obvious answer is "the purge door forgot them". It is not the answer, and a worker who
-- believes it will fix the wrong thing. `audit_log`, `grant_rule` and `drain_state` all declare
-- `ON DELETE CASCADE`, and `db/connection.ts` sets `foreign_keys = ON`. That cascade WORKS: on a
-- copy of the owner's own body, inserting an agent plus an `audit_log`, `grant_rule` and
-- `drain_state` row and then running `DELETE FROM agents` removed all three automatically. So
-- the live purge door cannot have minted these rows, before or after LANE-1's fix.
--
-- What mints them is a writer whose connection has FKs OFF, and it is not the engine:
-- `dojo-test-kit/behavioral/runner.mjs` tears the behavioural battery down by handing a block of
-- raw SQL to the **`sqlite3` CLI** (`execFileSync('sqlite3', [DB, stmts])`). The CLI leaves
-- `foreign_keys` OFF — that file's own comments acknowledge it in two places — so its
-- `DELETE FROM agents WHERE <name pattern>` deletes agent rows with NO cascade at all. Its
-- statement list names `messages`, `summaries`, `deliveries`, `conversations` and `work`, and
-- does NOT name `audit_log`, `grant_rule`, `drain_state` or `work_events`. Every count below
-- follows from exactly that:
--
--   audit_log    2,252 rows / 356 vanished agent ids   (never named by the teardown)
--   grant_rule     284 rows                            (never named)
--   drain_state      3 rows                            (never named)
--   work_events    481 rows                            (teardown deletes `work`, not its events)
--   messages         0 rows                            ← named by the teardown, so clean
--
-- The `messages` zero is the control that makes the diagnosis falsifiable: the same agent
-- deletions that left 2,252 `audit_log` rows left NO `messages` rows, and the only difference
-- between the two tables is that the teardown names one and not the other.
--
-- SO THIS FILE REPAIRS, AND DOES NOT PREVENT. Prevention is a KIT change, in a repository this
-- migration cannot reach; it is filed as its own backlog line in the lane report. LANE-1's door
-- fix (`agent/purge.ts`) hardens the engine side by deleting these tables explicitly instead of
-- trusting a per-connection pragma, so the door is correct even when opened with FKs off — but
-- nothing in the engine can stop a CLI writer from deleting an `agents` row behind its back.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ── WHAT IT TOUCHES ──
--   * a row in any agent-owned side table whose `agent_id` matches no `agents` row  -> DELETED
--   * `agents.parent_agent` naming an agent that no longer exists                   -> set NULL
--   * a `work_events` row whose `work_id` matches no `work` row                     -> DELETED
--   * anything whose parent EXISTS                                                  -> UNTOUCHED
--
-- The eight side-table statements are written out one per table rather than generated, because
-- the SQL gate prepares literal statements against the migrated schema and a `${…}` builder
-- hides them. Six of the eight are 0 rows on the owner's body and are here because another box's
-- history is not this one's: the predicate is what makes each a no-op where there is nothing to do.
--
-- `agents.parent_agent` is NULLED, never followed. A child is an independent agent; deleting one
-- because its parent is gone would be an unbounded blast radius, and the platform's own writers
-- (imaginer, healer, PM) RE-POINT that column at boot rather than depending on it. Same call
-- `172` made for `work.parent_id`.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- ⚠ DESTRUCTIVE, and only of rows that are already unreachable. Every reader of every table
-- below is agent-scoped or work-scoped, so a row naming a parent that does not exist is never
-- the subject of any read: `audit_log` is read by `report/collect.ts`'s `readAudit`
-- (`WHERE agent_id = ?`), `grant_rule` by `brokers/grants.ts`'s `grantFor` (same), `drain_state`
-- and `error_loop_state` likewise, and `work_events` only ever through its `work_id`.
--
-- It cannot over-reach: every statement is predicated on `NOT EXISTS (SELECT 1 FROM <parent>
-- WHERE id = <child>.<col>)`. `NOT EXISTS` rather than `NOT IN` deliberately — `NOT IN` against
-- a subquery that yields a single NULL returns NULL for every row and would silently delete
-- NOTHING, which is the quiet direction of that bug; `NOT EXISTS` has no NULL semantics to get
-- wrong. The test's COUNTERFACTUAL body drops the predicate and watches the same fixture lose
-- its live rows, so the guard is demonstrated rather than asserted.
--
-- Not the `.23`/`135` class: no JSON function, no CHECK re-evaluated by a delete, no column value
-- parsed, so it cannot RAISE on a row of any shape. Not the `139` class (final when it ships).
-- Not a `<NNN>b` bridge file, so the string-sort caveat does not apply. No DDL, no index, no
-- trigger, no table rebuild — so `applyOne`'s one-transaction-per-file wrapper holds.
--
-- IDEMPOTENT BY ITS PREDICATES, not by the `_migrations` marker: after the first run nothing
-- matches. The marker is the optimisation; the `WHERE` is the safety.
--
-- A fresh install applies every statement against empty tables and is correct.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITER: this file, once. Going forward, `agent/purge.ts`'s `purgeAgentRows()` — called only by
-- `gateway/routes/agents.ts`'s purge door — keeps these tables swept per agent. READERS of the
-- rows removed: none; that is the finding. Guarded by
-- `db/__tests__/migration-173-orphaned-agent-side-rows.test.ts` and, for the door half,
-- `gateway/routes/__tests__/a-purge-leaves-no-orphan-row.test.ts` — whose census clause fails if
-- a new table gains an FK to `agents` and nobody sweeps it.

-- ── 1-8. AGENT-OWNED SIDE ROWS WHOSE AGENT IS GONE ──
DELETE FROM audit_log
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = audit_log.agent_id);

DELETE FROM grant_rule
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = grant_rule.agent_id);

DELETE FROM drain_state
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = drain_state.agent_id);

DELETE FROM error_loop_state
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = error_loop_state.agent_id);

DELETE FROM briefings
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = briefings.agent_id);

DELETE FROM context_items
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = context_items.agent_id);

DELETE FROM large_files
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = large_files.agent_id);

DELETE FROM summaries
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = summaries.agent_id);

-- ── 9. A DANGLING PARENT LINK LOSES THE LINK, NEVER THE CHILD ──
UPDATE agents SET parent_agent = NULL
 WHERE parent_agent IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM agents p WHERE p.id = agents.parent_agent);

-- ── 10. EVENTS WHOSE WORK ROW IS GONE ──
DELETE FROM work_events
 WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = work_events.work_id);
