// ── EVERYTHING AN AGENT OWNS, DELETED IN ONE UNIT (BACKLOG LANE-1) ───────────────────────
//
// ── WHY THIS IS A MODULE AND NOT NINE LINES IN THE ROUTE ──
// `POST /api/agents/:id/purge` carried the delete sequence inline: seven hand-written
// statements, no transaction, and no way to tell from the route whether the list was COMPLETE.
// It was not. Ten tables carry a foreign key into `agents`, and the route named six of them —
// so the door had two outright FAILURE modes and three silent dependencies:
//
//   table               column         on delete    the door did
//   ─────────────────── ────────────── ──────────── ─────────────────────────────────────────
//   agents              parent_agent   NO ACTION    ⚠ NOTHING — purging a parent RAISED
//   briefings           agent_id       NO ACTION    ⚠ NOTHING — purging an agent with one RAISED
//   drain_state         agent_id       CASCADE      nothing; relied on the cascade
//   error_loop_state    agent_id       CASCADE      nothing; relied on the cascade
//   grant_rule          agent_id       CASCADE      nothing; relied on the cascade
//   audit_log           agent_id       CASCADE      explicit delete
//   messages            agent_id       CASCADE      explicit delete (+ the agent-bus half)
//   summaries           agent_id       NO ACTION    explicit delete (+ its two link tables)
//   context_items       agent_id       NO ACTION    explicit delete
//   large_files         agent_id       NO ACTION    explicit delete
//
// The two ⚠ rows are real bugs, not tidiness: with `foreign_keys = ON` — which is what
// `db/connection.ts` sets — `DELETE FROM agents` against a row that another agent names as its
// `parent_agent`, or that has a `briefings` row, **fails the FK check and the purge errors out**.
// `briefings` is empty on the owner's box, which is the only reason nobody has hit that half.
//
// ── WHY THE THREE `CASCADE` TABLES GET EXPLICIT DELETES ANYWAY ──
// Not belt-and-braces duplication. `memory/message-store.ts` already wrote the reason down for
// its own pair: FK enforcement is a **per-connection pragma**, and it is OFF for the whole
// migration chain — and, as this lane measured, OFF for every `sqlite3` CLI writer as well. A
// statement that is only correct while somebody else's pragma is set is not correct. These
// deletes make the sweep say what it means regardless of who opened the connection.
//
// That is not hypothetical: the 2,252 `audit_log`, 284 `grant_rule` and 3 `drain_state` rows
// migration `173` sweeps were all minted by exactly that hole — see the WHERE THE ORPHANS CAME
// FROM note in that file.
//
// ── ONE UNIT ──
// The sequence was a bare run of `db.prepare().run()` calls, so a failure part-way left a
// half-purged agent: rows gone, agent still listed. `withUnit` makes it atomic, which is also
// what makes the FK ordering below a guarantee rather than a hope.

import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { deleteAllForAgent, deleteAgentBusRowsFor } from '../memory/message-store.js';
import { deleteAllWorkForAgent } from '../work/purge-sweep.js';

/** What the sweep removed, for the log line and the route's response. */
export interface PurgeCounts {
  readonly messages: number;
  readonly workRows: number;
  readonly orphanedChildren: number;
}

/**
 * Delete every row this agent owns, and the agent, in ONE transaction.
 *
 * Caller owns the GATES (not the primary, terminated, exists). This owns the rows.
 *
 * ── THE ORDER IS FK-DRIVEN, AND EVERY STEP IS EITHER A DEPENDENT OR A LINK ──
 *  1. `agents.parent_agent` is NULLED on this agent's CHILDREN, never followed. A child is an
 *     independent agent that may be mid-turn; deleting it because its parent was purged would
 *     be an unbounded blast radius, and the platform's own writers treat the link as soft (the
 *     imaginer, healer and PM all RE-POINT `parent_agent` at boot rather than depending on it).
 *     Losing a null here is the lesser damage, and it is the same call `work.parent_id` gets in
 *     `work/purge-sweep.ts`.
 *  2. The summary link tables go before `summaries`, which they reference.
 *  3. The work spine goes through its own owner, which has its own four-way FK order.
 *  4. `agents` goes LAST, when nothing references it any more.
 */
export function purgeAgentRows(agentId: string): PurgeCounts {
  const db = getDb();
  let counts: PurgeCounts = { messages: 0, workRows: 0, orphanedChildren: 0 };

  withUnit(() => {
    // 1. CHILDREN SURVIVE, the link does not. Before the agent row goes, or the self-FK raises.
    const orphanedChildren = db.prepare(
      'UPDATE agents SET parent_agent = NULL WHERE parent_agent = ?',
    ).run(agentId).changes;

    // 2. Conversation. Both directions of the bus: the rows this agent RECEIVED go with the
    //    first call; the ones it SENT live on the recipient's row and need the second.
    const messages = deleteAllForAgent(agentId);
    deleteAgentBusRowsFor(agentId);

    // 3. Summaries, link tables first.
    db.prepare(
      'DELETE FROM summary_messages WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)',
    ).run(agentId);
    db.prepare(
      `DELETE FROM summary_parents
        WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)
           OR parent_id  IN (SELECT id FROM summaries WHERE agent_id = ?)`,
    ).run(agentId, agentId);
    db.prepare('DELETE FROM summaries WHERE agent_id = ?').run(agentId);

    // 4. The rest of this agent's own side tables. `briefings` is the one this list was
    //    missing; the other three are the `CASCADE` tables the door was trusting a pragma for.
    db.prepare('DELETE FROM context_items WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM large_files WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM briefings WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM audit_log WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM grant_rule WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM drain_state WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM error_loop_state WHERE agent_id = ?').run(agentId);

    // 5. The work spine — no FK on `work.agent_id` at all (migration 135, PART 0 rider 1), so
    //    nothing in the database would ever do this.
    const workRows = deleteAllWorkForAgent(agentId);

    // 6. The agent itself.
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);

    counts = { messages, workRows, orphanedChildren };
  });

  return counts;
}
