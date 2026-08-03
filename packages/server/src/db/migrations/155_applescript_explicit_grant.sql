-- 155 (PHASE-5 T5): APPLESCRIPT BECOMES AN EXPLICIT GRANT IN EVERY STORED MANIFEST.
--
-- WHAT THIS PRESERVES, AND WHY IT IS A MIGRATION RATHER THAN A CODE CHANGE.
-- The plan's direction, written at T3 Step 2, is that osascript is "an
-- unrestricted second shell — never again inside `system_control:'*'`". T3 made
-- `applescript` its own audited grant class but deliberately left `'*'` covering
-- it, because a live agent held ONLY `'*'` and removing it blind would have
-- taken a working capability away. A narrowing is the owner's decision, never a
-- worker's.
--
-- The preserving order is therefore: every `'*'` HOLDER gains an explicit
-- `'applescript'` grant FIRST, and only then does `'*'` stop meaning it. In code
-- that is one line (`PRIMARY_AGENT_PERMISSIONS.system_control`). For every agent
-- whose grant lives in a DATABASE ROW it is this file, and the two are one
-- change: ship the projection flip without this migration and every `'*'`-holding
-- agent on every box silently loses AppleScript on the next boot.
--
-- ⚠ WHO ACTUALLY HOLDS `'*'` WAS MEASURED, NOT INHERITED. The plan states that
-- the only two holders are the primary and the Healer. On the dev body at this
-- task's HEAD the Healer holds `system_control: []` — no system control at all —
-- while TWO SPAWNED SUB-AGENTS hold `["*"]`, inherited verbatim from the primary
-- at spawn time. So the set this migration exists for is not the one the plan
-- names, which is exactly why it is derived by a query here instead of by an
-- id list. The measurement is in `.superpowers/sdd/PHASE-5/task-T5-report.md` §3.
--
-- ── WHAT IT TOUCHES, PRECISELY ──
--   * a manifest whose `system_control` ARRAY contains '*'  → append 'applescript'
--   * a manifest whose `system_control` is the STRING '*'    → becomes ['*','applescript']
--     (the projection has always read both spellings — `grants.ts` reads it
--     `Array.isArray(c) ? … : c === '*'` — so normalising the scalar to the
--     one-element array it already meant loses nothing and is the first step of
--     the validated shape T5 owns)
--   * everything else                                       → UNTOUCHED
--
-- A manifest that already names `applescript` or `applescript_run` is skipped,
-- which is what makes this idempotent: running it twice appends nothing.
--
-- ── NOT TOUCHING `grant_rule`, ON PURPOSE ──
-- The rows are a projection stamped with the fingerprint of the manifest they
-- came from, and `brokers/grants.ts:grantFor()` re-projects the instant a stored
-- fingerprint does not match. Editing the manifest CHANGES that fingerprint, so
-- the rows re-derive themselves on the agent's next authorize. Deleting them
-- here would be a second mechanism doing a job that already has an owner.
--
-- ── THE `json_valid` GUARD IS LOAD-BEARING AND IT IS WRITTEN AS A CASE ──
-- Rehearsal (roadmap #16) against an adversarial body decided this shape rather
-- than argument. `agents.permissions` is a free-text column with no CHECK: a
-- lived-in box carries rows that are `NULL`, `''`, `'{}'`, legacy shapes with no
-- `system_control` key at all, and — measured on a planted body — text that is
-- not JSON. SQLite's json functions RAISE on malformed input, and a raise inside
-- a migration aborts the CHAIN, which aborts the BOOT. That is the `.23` / `135`
-- incident class exactly. `json_valid()` alone is not enough of a guard, because
-- nothing in SQL guarantees a later AND term is not evaluated first; the CASE
-- below guarantees that no json function ever SEES a value it can raise on,
-- because the malformed row is replaced by `'{}'` before it gets there.
-- `__tests__/migration-155-applescript-grant.test.ts` drives all four bodies,
-- including the counterfactual where the guard is removed.

-- (1) The ARRAY spelling: append 'applescript' where '*' is present and no
--     explicit applescript grant already is.
UPDATE agents
SET permissions = json_replace(
      permissions,
      '$.system_control',
      json_insert(json_extract(permissions, '$.system_control'), '$[#]', 'applescript')
    )
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.system_control') = 'array'
  AND EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(agents.permissions) THEN agents.permissions ELSE '{}' END, '$.system_control')
        WHERE value = '*'
      )
  AND NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(agents.permissions) THEN agents.permissions ELSE '{}' END, '$.system_control')
        WHERE value IN ('applescript', 'applescript_run')
      );

-- (2) The SCALAR spelling: `system_control: "*"` becomes `["*","applescript"]`.
UPDATE agents
SET permissions = json_replace(permissions, '$.system_control', json_array('*', 'applescript'))
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.system_control') = 'text'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.system_control') = '*';
