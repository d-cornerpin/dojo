-- 175 (RELEASE-BLOCKER ROUND): THE VERDICT THAT OUTLIVED ITS WORK ROW.
--
-- The third and last of the orphan sweeps. `172` took the `work` rows a purge left behind, `173`
-- took the agent-owned side rows and the `work_events` whose row was gone. This takes the ONE
-- family neither of them covered — `adjudications` — plus the other two work references, so the
-- spine is complete rather than nearly complete.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ THIS ONE IS A LIVE TAP, NOT HISTORY, AND THAT IS WHY THE SOURCE FIX SHIPS WITH IT.
--
-- `172` and `173` ran on the owner's box and left the body clean. **About an hour later a new
-- `adjudications -> work` orphan appeared.** So unlike the earlier two sweeps, this damage was
-- still being produced, and a migration alone would have been swept away again by the next
-- occurrence that got released.
--
-- THE WRITER, named: `work/occurrences.ts`, both of its delete paths.
--
--   releaseOccurrence()    the scheduler could not claim the occurrence, so the row is deleted
--                          and its sequence freed for the next tick
--   deleteOccurrencesOf()  a schedule is deleted, so its occurrence children go with it
--
-- Both swept `work_events` and neither swept `adjudications`. An occurrence CAN carry one and
-- nothing guarded against it: `store.ts`'s `transition()` writes an adjudication for any row
-- closed with an authoritative claim or by a system closer, with NO `kind` check, and
-- `settleOccurrence()` closes occurrences as `scheduler`. The live orphan is exactly that shape —
-- `claim_state='done'`, `verdict='upheld'`, a bare-uuid `work_id` (which is what `uuidv4()` mints
-- for an occurrence), and zero surviving `work_events`, because the deleter cleaned those.
--
-- Both call sites now sweep `adjudications`, and both also NULL `techniques.build_project_id`.
-- That fourth reference was found by the new work-side FK census clause rather than by reading:
-- `techniques/store.ts` takes `buildProjectId` as a caller-supplied `string | null` with no kind
-- constraint, so the declared FK permits it to name an occurrence — and because it is `NO ACTION`
-- the consequence is not a lost row but a **RAISE**, i.e. a schedule that cannot be deleted.
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- ── WHAT IT TOUCHES ──
--   * an `adjudications` row whose `work_id` matches no `work` row   -> DELETED
--   * a `work_events` row whose `work_id` matches no `work` row      -> DELETED (173's family;
--     re-stated here because the same tap produces both and `173` is already applied everywhere)
--   * `work.parent_id` naming a `work` row that is gone             -> set NULL
--   * `techniques.build_project_id` naming a `work` row that is gone -> set NULL
--   * anything whose parent EXISTS                                  -> UNTOUCHED
--
-- Those four are the COMPLETE set of references into `work(id)`, and that is not a claim from
-- reading: `work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts` reads them out of
-- `PRAGMA foreign_key_list` at run time, pins the count at four, and fails if a fifth appears.
--
-- MEASURED on the owner's body at this commit: `adjudications` **1**, and 0 for the other three —
-- the other three are here because another box's history is not this one's, and because the
-- predicate makes each a no-op where there is nothing to do.
--
-- A verdict is NOT nulled or kept: an adjudication is a statement ABOUT one work row
-- (`work_id` is `NOT NULL`), so with that row gone there is no question for it to answer.
-- `work.parent_id` and `techniques.build_project_id` ARE nulled rather than followed, because a
-- child work row and a technique each outlive the thing that referenced them — the same call
-- `172` made for `work.parent_id` and `purge-sweep.ts` makes for the technique link.
--
-- ── WHY IT IS SAFE ON A LIVED-IN BODY ──
-- ⚠ DESTRUCTIVE of two row families, and only of rows already unreachable: every reader of
-- `adjudications` reaches it through its `work_id` (`tracker-view.ts`'s `validatedExpr`,
-- `store.ts`'s `revertCount`), and every reader of `work_events` through its own. A row naming a
-- `work` row that does not exist is never the subject of any read.
--
-- `NOT EXISTS`, never `NOT IN`: `NOT IN` against a subquery yielding a single NULL returns NULL
-- for every row and would silently delete NOTHING — the quiet direction of that bug.
--
-- Not the `.23`/`135` class (no JSON function, no CHECK re-evaluated by a delete, no column value
-- parsed — it cannot RAISE on a row of any shape). Not the `139` class (final when it ships). Not
-- a `<NNN>b` bridge file, so the string-sort caveat does not apply. No DDL. Transaction-safe, so
-- `applyOne`'s wrapper holds.
--
-- IDEMPOTENT BY ITS PREDICATES. A fresh install applies all four against empty tables.
--
-- ── NEXT-RELEASE AUDIT NOTE ──
-- WRITER: this file, once. Going forward the two `work/occurrences.ts` paths keep `adjudications`
-- swept, `work/purge-sweep.ts` keeps the agent-scoped case, and `work/tracker-store.ts` already
-- swept its own. READERS of the rows removed: none. Guarded by
-- `db/__tests__/migration-175-orphaned-work-references.test.ts` and by the work-side census in
-- `work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts`.

-- ── 1. THE VERDICT WHOSE QUESTION IS GONE ──
DELETE FROM adjudications
 WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = adjudications.work_id);

-- ── 2. THE SAME TAP'S OTHER FAMILY (173's, re-stated because 173 is already applied) ──
DELETE FROM work_events
 WHERE NOT EXISTS (SELECT 1 FROM work w WHERE w.id = work_events.work_id);

-- ── 3. A CHILD OUTLIVES ITS PARENT, LOSING ONLY THE LINK ──
UPDATE work SET parent_id = NULL
 WHERE parent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = work.parent_id);

-- ── 4. A TECHNIQUE OUTLIVES WHATEVER BUILT IT ──
UPDATE techniques SET build_project_id = NULL
 WHERE build_project_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM work w WHERE w.id = techniques.build_project_id);
