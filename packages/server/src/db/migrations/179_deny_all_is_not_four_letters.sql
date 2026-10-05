-- 179: THE SWEEP FOR `file_read` / `file_write` ROWS THAT HOLD THE LETTERS N-O-N-E.
--
-- ── THE DEFECT, WHICH IS ALREADY FIXED IN CODE ──
-- `agent/manifest.ts`'s `withArtifactPath` guarded exactly one scalar, `'*'`, and let every
-- other value fall through to the list branch:
--
--     return value.includes(artifact) ? value : [...value, artifact];
--
-- `'none'` is the OTHER live scalar on these two fields — the zod `pathList` in `agent/scope.ts`
-- admits it deliberately, the platform writes it itself (`tracker/pm-agent.ts` stores
-- `file_write: 'none'`), and it means DENY-ALL. On that value `[...'none', artifact]` ITERATES
-- THE STRING, so the stored manifest became four one-letter ALLOW patterns plus the artifact
-- directory. The code fix (the `'none'` guard, and the widened `PermissionManifest` type that let
-- the value reach the spread in the first place) is guarded by
-- `agent/__tests__/deny-all-is-not-four-letters.test.ts`. THIS FILE IS THE OTHER HALF: rows
-- already written that way, which no code fix can reach.
--
-- ── THE EXACT SHAPE ON DISK, MEASURED RATHER THAN ASSUMED ──
-- The sole producer is the spawn/create path: `scope.ts`'s `defaultChildScope` calls
-- `withArtifactPaths` on the PARENT's manifest and `resolveChildScope` JSON-serializes the
-- result into the new child's row. Driving the pre-fix helper directly measured two shapes:
--
--   pass 1 (deny-all parent -> child row)
--     ["n","o","n","e","<home>/.dojo/uploads/<childId>/**"]
--   pass 2 (that corrupted row spawns again — THE CORRUPTION COMPOUNDS)
--     ["n","o","n","e","<home>/.dojo/uploads/<childId>/**","<home>/.dojo/uploads/<grandchildId>/**"]
--
-- So the invariant is: the first four elements are exactly `n`,`o`,`n`,`e`, followed by ONE OR
-- MORE artifact-directory paths. There is always at least a fifth element, because
-- `'none'.includes(artifact)` is `String.prototype.includes` and is always false here, so the
-- append never short-circuits.
--
-- ── WHY THE BARE FOUR-ELEMENT ARRAY IS DELIBERATELY NOT SWEPT ──
-- A row holding exactly `["n","o","n","e"]` and nothing else is NOT producible by this defect
-- (see above: the artifact path is always appended), and a tree-wide search finds no other site
-- that spreads either field. Meanwhile it is indistinguishable from a LEGITIMATE allowlist of
-- four one-character paths. Rewriting that to deny-all would narrow a real agent's reach on a
-- guess, which is the one thing a sweep may not do — so the fifth element is REQUIRED to be an
-- artifact directory, and that is what makes the predicate provable instead of merely plausible.
-- The adversarial body plants the bare four and asserts it SURVIVES.
--
-- ── WHY THE REPAIR IS THE SCALAR `'none'` AND NOT `[]` ──
-- Both read as deny-all at a glance and they are NOT equivalent, which rehearsal measured:
-- `withArtifactPath([])` takes the list branch and appends the artifact directory, so a row
-- repaired to `[]` comes back from the very next `getAgentPermissions` as
-- `["<home>/.dojo/uploads/<id>/**"]` and `brokers/grants.ts` projects TWO REAL ALLOW RULES from
-- it (`fs_read` and `fs_write` on that directory). Repairing to `[]` would therefore WIDEN every
-- swept agent. `'none'` projects zero allow rules, and it is byte-for-byte the value the fixed
-- helper now produces for these rows — the exact inverse of the corruption, not a near neighbour.
--
-- ── WHY AN UNDOCUMENTED SCALAR LIKE `'all'` IS EXCLUDED, AND IT IS EXCLUDED ON PROOF ──
-- The spread fires on ANY non-`'*'` string, so `'all'` would have become `["a","l","l",…]`. It is
-- excluded because no write path can store it: `scope.ts`'s `pathList` is
-- `z.union([z.literal('*'), z.literal('none'), z.array(z.string())])`, so a manifest naming any
-- other scalar is REFUSED at `validateManifest` before it reaches a row. `'none'` is the only
-- scalar that is both admitted by the schema and spread by the old helper. And unlike `'none'`,
-- `'all'` has no deny-all meaning to restore, so a sweep would be inventing intent.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- Two `UPDATE`s, no DDL. `agents.permissions` is free-text with NO CHECK constraint, so a
-- lived-in box carries every shape anybody ever wrote: `NULL`, `''`, `'{}'`, text that is not
-- JSON at all, legacy manifests with neither key, and an object where an array belongs. SQLite's
-- json functions RAISE on malformed input, a raise inside a migration aborts the CHAIN, and an
-- aborted chain aborts the BOOT — the `.23` / `135` incident class.
--
-- ⚠ THE `json_valid` GUARD IS WRITTEN AS A CASE AT EVERY SINGLE CALL SITE, ON PURPOSE.
-- `json_valid(permissions) AND json_type(permissions, …)` is NOT a sufficient guard, because
-- nothing in SQL guarantees that a later `AND` term is not evaluated first. The CASE guarantees
-- that no json function ever SEES a value it can raise on, because a malformed row has already
-- been replaced by `'{}'` before it gets there. This is the shape migration 155 landed for the
-- same column after the same rehearsal, and `__tests__/migration-179-deny-all-sweep.test.ts`
-- drives the counterfactual body with the guard removed, proving it is load-bearing and not
-- decorative.
--
-- The `SET` expressions do NOT need the CASE: every row reaching one has already satisfied a
-- CASE-guarded `json_type(...) = 'array'`, which a malformed row cannot. `json_replace` rather
-- than `json_set` so the statement can only ever REWRITE a key that is already an array — it can
-- never CREATE one on a manifest that never had it.
--
-- IDEMPOTENT BY ITS PREDICATE: after the first pass the field is the scalar `'none'`, whose
-- `json_type` is `text`, not `array`, so a second run matches zero rows. A fresh install has no
-- agents and this is a no-op there.
--
-- Not the `139` class (not final when it ships). Not a `<NNN>b` bridge file. No DDL, no index.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- PRODUCER of the corrupted shape: nobody, from now on — `agent/manifest.ts`'s `withArtifactPath`
-- returns `'none'` untouched. The two write-back paths that persist a manifest,
-- `agent/access/materialize.ts`'s `writeGrants` and `agent/tools/cat/agents.ts`'s update branch,
-- both re-serialize the RAW stored blob rather than a `getAgentPermissions` result, so neither
-- ever created this shape and neither re-creates it after this sweep.

-- (1) file_read: the four letters followed by at least one artifact directory, back to deny-all.
UPDATE agents
SET permissions = json_replace(permissions, '$.file_read', 'none')
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read') = 'array'
  AND json_array_length(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read') >= 5
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read[0]') = 'n'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read[1]') = 'o'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read[2]') = 'n'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read[3]') = 'e'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_read[4]') LIKE '%/.dojo/uploads/%';

-- (2) file_write: the same shape on the other field. A row can be corrupted on one field only
--     (a parent holding `file_write: 'none'` with a real `file_read` list is the live PM shape),
--     so these are two independent statements rather than one with an OR.
UPDATE agents
SET permissions = json_replace(permissions, '$.file_write', 'none')
WHERE json_type(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write') = 'array'
  AND json_array_length(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write') >= 5
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write[0]') = 'n'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write[1]') = 'o'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write[2]') = 'n'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write[3]') = 'e'
  AND json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.file_write[4]') LIKE '%/.dojo/uploads/%';
