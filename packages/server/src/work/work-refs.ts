// ── EVERYTHING THAT POINTS AT A WORK ROW, IN ONE PLACE (release-blocker round) ────────────
//
// FOUR things reference `work(id)`, and every one of them is `NO ACTION`:
//
//   work_events.work_id            deleted with the row
//   adjudications.work_id          deleted with the row
//   techniques.build_project_id    NULLED — a technique outlives whatever built it
//   work.parent_id (itself)        NULLED — a child work row outlives its parent
//
// `NO ACTION` means the database does nothing for you: every path that deletes a work row has to
// clear all four by hand, and a path that clears three of four either strands a row or — because
// `NO ACTION` REFUSES rather than cascades — raises and cannot complete at all.
//
// ── WHY THIS IS A MODULE ──
// Three call sites had three different ideas of the list. `work/tracker-store.ts` swept
// `work_events` and `adjudications`; `work/purge-sweep.ts` swept those plus the two nullable
// links; `work/occurrences.ts` swept only `work_events`, which is the defect this round closes
// (a released occurrence left its verdict behind, measured live an hour after migrations 172 and
// 173 cleaned the older damage). A list that lives in one place can be wrong once; a list copied
// into three can be wrong three different ways, and was.
//
// The census clause in `work/__tests__/a-deleted-work-row-leaves-no-verdict.test.ts` reads the
// four references out of `PRAGMA foreign_key_list` at run time and fails if a fifth appears — so
// this comment cannot quietly go stale.

import { getDb } from '../db/connection.js';

/**
 * Clear every reference into `workIds` so the rows can be deleted. Does NOT delete the work rows
 * themselves — the caller owns that, because each caller's predicate differs (by id, by parent,
 * by agent) and only the caller knows what it means to have deleted them.
 *
 * Call inside the caller's `withUnit`: clearing references and deleting the rows they point at is
 * one fact, and a failure between the two halves is the state this exists to prevent.
 *
 * A no-op on an empty list, deliberately — a caller that resolved nothing must not turn into a
 * statement with an empty `IN ()` that matches differently than intended.
 */
export function clearReferencesToWork(workIds: readonly string[]): void {
  if (workIds.length === 0) return;
  const db = getDb();
  const ph = workIds.map(() => '?').join(',');
  // Order is irrelevant among these four — none references another — but the deletes come first
  // so a reader sees "remove what is owned, then release what merely points".
  db.prepare(`DELETE FROM work_events WHERE work_id IN (${ph})`).run(...workIds);
  db.prepare(`DELETE FROM adjudications WHERE work_id IN (${ph})`).run(...workIds);
  db.prepare(`UPDATE techniques SET build_project_id = NULL WHERE build_project_id IN (${ph})`).run(...workIds);
  db.prepare(`UPDATE work SET parent_id = NULL WHERE parent_id IN (${ph})`).run(...workIds);
}
