-- 168 (ANSWER-ANYWAY, work grants): EVERY AGENT THAT ALREADY EXISTS GAINS THE WORK TRACKER.
--
-- OWNER RULING, VERBATIM, 2026-09-22: "By default, all agents should have this
-- ability. It defeats the entire purpose of the dojo and you have gates that
-- prevent the agents from working if they don't open a task."
--
-- WHAT WENT WRONG ON THE OWNER'S BOX. A live primary-adjacent agent called
-- `work_open` and was refused — "work_open is in the 'Open Work…' or 'Work
-- Tracker…' tool group, which is not in this agent's grants" — in the SAME TURN
-- that the engine's start-ack hint told it "their request is being worked as a
-- tracked job". The platform required the tracker and withheld it at once. The
-- code half of the fix is `MOST_RESTRICTIVE_GRANTS` in `packages/shared/src/
-- access.ts`, which carves the two work groups out of the most-restrictive
-- default so every agent CREATED from here on holds them. This file is the other
-- half, and the two are one change: ship the constant alone and every agent
-- already on the owner's stable box stays locked out, because a stored grants
-- object always beats the default.
--
-- ONE STORED DECISION IS OVERRIDDEN, DELIBERATELY (review F1): an agent whose
-- owner deliberately REVOKED these groups before this migration GAINS THEM
-- BACK. That is the ruling's intent — the revocation predates the rule that
-- these groups are a birthright — and this sentence exists so nobody reads the
-- backfill as preserving it. A revocation made AFTER this migration sticks
-- (no boot-time re-floor; pinned by test).
--
-- ── WHAT IT TOUCHES, PRECISELY ──
--   * a row whose `$.grants.tools.categories` is an ARRAY not containing
--     'Open Work (what you still owe)'                        → append it
--   * the same, for 'Work Tracker (projects, tasks, reminders, promises)'
--   * a row whose `$.grants.tools.categories` is the STRING '*' → UNTOUCHED
--     ('*' already holds every category, including these two)
--   * a row with NO `$.grants` key, or `NULL` / `''` / `'{}'` / unparseable
--     permissions                                              → UNTOUCHED
--   * everything else                                          → UNTOUCHED
--
-- WHY THE UNDECLARED ROWS ARE LEFT ALONE, AND WHY THAT IS NOT A GAP. A row with
-- no stored grants is answered by `access/derive.ts`, whose measured snapshot is
-- `categories: '*'` — so such an agent ALREADY holds both groups, and the boot
-- materializer (`access/materialize.ts`, which runs right after this chain and
-- writes only where nothing is declared) will write that '*' into the row as it
-- always has. Reaching into those rows from SQL would be this migration doing
-- the materializer's job badly: it would have to reconstruct the whole
-- AccessGrants object in SQL, and a shape that `storedGrants` then rejected
-- (`read.ts`: v !== 1, or a missing section) would silently send the agent back
-- to the derivation while looking migrated.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- It only ever APPENDS a string to a JSON array that is already there. No row is
-- created or deleted, no other key inside `permissions` is read or rewritten
-- (the column also carries the PermissionManifest, which json_replace on the
-- single categories path leaves byte-untouched), and no agent LOSES anything: a
-- category grant is positive — holding one more label can only widen what
-- `toolCategoryGranted` answers yes to, never narrow it. The widening is bounded
-- to two labels whose tools (`work_open`, `work_update`, `work_note`,
-- `work_close_request`, `work_validate`, `work_schedule`) write rows in this
-- box's own `work` table and reach no human, no integration, no credential and
-- no network.
--
-- `updated_at` is NOT bumped, on purpose. This is a platform backfill, not an
-- owner edit; bumping it would reorder every agent in the dashboard's
-- recently-changed view and make a silent migration look like the owner had just
-- touched all of them. The grants memo (`access/read.ts`) is keyed on the raw
-- `permissions` text, so it self-invalidates on the next read without a
-- timestamp change.
--
-- ── IDEMPOTENT, AND NOT ONLY BECAUSE THE RUNNER RECORDS IT ──
-- Each statement's `NOT EXISTS` clause excludes any row that already names the
-- label, so a second run appends nothing. The `_migrations` marker is an
-- optimisation; the WHERE clause is the safety.
--
-- ── THE `json_valid` GUARD IS LOAD-BEARING AND IT IS WRITTEN AS A CASE ──
-- Cited verbatim from `155_applescript_explicit_grant.sql`, the only other
-- migration that does JSON surgery on this column. `agents.permissions` is a
-- free-text column with no CHECK: a lived-in box carries rows that are `NULL`,
-- `''`, `'{}'`, legacy shapes with no `grants` key at all, and — measured on a
-- planted body — text that is not JSON at all. SQLite's json functions RAISE on
-- malformed input, and a raise inside a migration aborts the CHAIN, which aborts
-- the BOOT. That is the `.23` / `135` incident class exactly. `json_valid()`
-- alone is not enough of a guard, because nothing in SQL guarantees a later AND
-- term is not evaluated first; the CASE below guarantees that no json function
-- ever SEES a value it can raise on, because the malformed row is replaced by
-- `'{}'` before it gets there.
--
-- ── NOT A FLOOR, AND THAT DISTINCTION IS THE POINT ──
-- This runs ONCE. Nothing re-applies it at boot. An owner who afterwards revokes
-- a work group in the Access panel keeps it revoked across every restart — the
-- four boot reconcilers that used to rewrite `permissions` on every start were
-- deleted precisely because silently reverting the owner is worse than the
-- narrowing they were trying to prevent.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITER: this file, once. READERS: `agent/access/read.ts` (`readStoredGrants` →
-- `toolCategoryGranted`), which is asked by BOTH the advertised-surface strip
-- (`agent/tools/surface.ts`) and the executor's row-17 category gate
-- (`agent/tools/gate-eval.ts`). The two labels are also named in
-- `packages/shared/src/access.ts` (`MOST_RESTRICTIVE_GRANTS`, the creation
-- default) and are pinned against the real `TOOL_CATEGORIES` labels by
-- `agent/access/__tests__/the-work-tracker-is-not-optional.test.ts`, so a
-- re-label fails the build rather than turning these two strings into dead
-- grants.

-- (1) 'Open Work (what you still owe)'
UPDATE agents
SET permissions = json_replace(
      permissions,
      '$.grants.tools.categories',
      json_insert(
        json_extract(permissions, '$.grants.tools.categories'),
        '$[#]',
        'Open Work (what you still owe)'
      )
    )
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.grants.tools.categories') = 'array'
  AND NOT EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(agents.permissions) THEN agents.permissions ELSE '{}' END,
          '$.grants.tools.categories'
        )
        WHERE value = 'Open Work (what you still owe)'
      );

-- (2) 'Work Tracker (projects, tasks, reminders, promises)'
UPDATE agents
SET permissions = json_replace(
      permissions,
      '$.grants.tools.categories',
      json_insert(
        json_extract(permissions, '$.grants.tools.categories'),
        '$[#]',
        'Work Tracker (projects, tasks, reminders, promises)'
      )
    )
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.grants.tools.categories') = 'array'
  AND NOT EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_valid(agents.permissions) THEN agents.permissions ELSE '{}' END,
          '$.grants.tools.categories'
        )
        WHERE value = 'Work Tracker (projects, tasks, reminders, promises)'
      );
