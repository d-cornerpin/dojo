// ── PURGING AN AGENT TAKES ITS WORK WITH IT (BACKLOG WAVE-1A) ────────────────────────────
//
// ── WHY THIS IS A MODULE AND NOT A LINE IN THE ROUTE ──
// The delete is two statements; the ORDER is the reason this has a file. Four things reference
// `work(id)`, all `NO ACTION`, and the server runs with `foreign_keys = ON` — so a naive
// `DELETE FROM work WHERE agent_id = ?` FAILS the moment the agent owns both a parent and its
// child. That knowledge belongs with the rows, not inlined in an HTTP handler, and it is needed
// in exactly one other place: migration `172_orphaned_work_rows.sql`, which is the same five
// statements over the already-orphaned set. The two must not be able to drift apart quietly, so
// the migration's header names this function and this header names the migration.
//
// ── WHY NOT IN `work/store.ts` ──
// That module is the spine's ONE WRITER OF `work.state` and says so in its header; a delete is
// not a transition. It is also 2,076 lines and pinned decrease-only by the size ratchet, which
// is the tree's standing instruction not to grow it.

import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';

/**
 * Every `work` row this agent owns, and the rows that hang off them. Returns the number of
 * `work` rows removed.
 *
 * ── WHY IT HAD TO BE WRITTEN AT ALL ──
 * `work.agent_id` carries NO foreign key and NO cascade, deliberately: migration 135's PART 0
 * rider 1 keeps a work row readable after its agent is gone, so the spine's history survives a
 * deletion. The cost nobody closed is that NOTHING deleted those rows either — so
 * `POST /api/agents/:id/purge`, which sweeps seven other tables by hand, walked straight past
 * the work spine. Measured on the owner's body before this landed: 18 orphaned `work` rows
 * pointing at agents that no longer existed, carrying 78 `work_events` between them.
 *
 * An `on_deck` row is the sharp end — that is the state `scheduler/runner.ts` polls every 30
 * seconds, so an orphan in it is a timer still armed for an agent that cannot run. The sweep is
 * NOT limited to `on_deck`: a purge removes the agent's data, not a subset of its states.
 *
 * ── THE ORDER, WHICH IS FK-DRIVEN ──
 *   1. `work_events.work_id`         — deleted with their row.
 *   2. `adjudications.work_id`       — same.
 *   3. `techniques.build_project_id` — NULLED, never deleted. A technique outlives the project
 *                                      that built it; the column is nullable for that reason.
 *   4. `work.parent_id` (SELF)       — NULLED on every row pointing INTO the doomed set,
 *                                      including the doomed set's own rows. That is what makes
 *                                      the final DELETE order-independent: SQLite checks an
 *                                      immediate FK per row, so deleting a parent before its
 *                                      child inside one statement would otherwise fail. 4 such
 *                                      pairs existed among the live orphans.
 *                                      A SURVIVING row belonging to another agent is left
 *                                      pointing at nothing rather than deleted — its own agent
 *                                      still owns it, and a null `parent_id` is the lesser damage.
 *
 * `defer_foreign_keys` would also solve (4) and is deliberately not used: it would make
 * correctness depend on a pragma holding for the whole transaction, where nulling first makes it
 * depend on statement order inside one unit — which is visible right here.
 *
 * One unit, via `withUnit`, so a failure mid-sweep cannot leave a row whose events are gone.
 *
 * ⚠ KNOWN RESIDUAL, stated rather than fixed here: if a SURVIVING agent's row was counting this
 * agent's rows as children (`remaining_children`), that countdown is now short. No cross-agent
 * parent link exists on the owner's body (measured: 0), and reconciling a fan-out countdown is
 * `work-reaper.ts`'s job, not a delete's.
 */
export function deleteAllWorkForAgent(agentId: string): number {
  const db = getDb();
  let removed = 0;
  withUnit(() => {
    const doomed = 'SELECT id FROM work WHERE agent_id = ?';
    db.prepare(`DELETE FROM work_events WHERE work_id IN (${doomed})`).run(agentId);
    db.prepare(`DELETE FROM adjudications WHERE work_id IN (${doomed})`).run(agentId);
    db.prepare(`UPDATE techniques SET build_project_id = NULL WHERE build_project_id IN (${doomed})`).run(agentId);
    db.prepare(`UPDATE work SET parent_id = NULL WHERE parent_id IN (${doomed})`).run(agentId);
    removed = db.prepare('DELETE FROM work WHERE agent_id = ?').run(agentId).changes;
  });
  return removed;
}
