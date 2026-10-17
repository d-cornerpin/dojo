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
// (That table is the state of the door when it was first written down. The sweep below no longer
// names its tables: see PURGE_KEEPS.)
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
import { deleteAllWorkForAgent, releaseWorkPointersIntoAgent, deleteAgentDeliveries } from '../work/purge-sweep.js';
import { agentPurgedForOwner } from './agent-owner-cards.js';
import { endBudgetCard } from '../costs/budget-cards.js';
import { budgetStopKey, ownerConditionCleared } from '../healer/owner-notices.js';

// ── WHAT A PURGE KEEPS, AND NOTHING ELSE (t189 B4, owner decision 28) ──
// "Keep the purged agent's SPENDING history for cost reports; remove everything else."
// The purge used to be a hand-written list, so each table added after it became an orphan
// class (25 tables of rows, plus the agent's budget row, were left behind when this was
// measured). It is now the OTHER way round: every table with an `agent_id` column is swept,
// found from the schema each time, and only the tables named HERE survive, each with its reason.
// A new per-agent table is therefore swept the day its migration lands; keeping one is a
// deliberate edit to this list, and `__tests__/t189-purge-sweeps-every-agent-table.test.ts`
// fails on any other outcome.
export const PURGE_KEEPS: Readonly<Record<string, string>> = {
  cost_records: 'Spending history: the cost reports and the budget windows read it, and the owner asked for it to outlive the agent (decision 28).',
};

/** Every table with an `agent_id` column, from the live schema, minus the kept ones. */
function agentOwnedTables(): string[] {
  return (getDb().prepare(
    `SELECT m.name FROM sqlite_master m
      WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
        AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'agent_id')
      ORDER BY m.name`,
  ).all() as Array<{ name: string }>).map((r) => r.name).filter((t) => !(t in PURGE_KEEPS));
}

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
 *  4. Every other table with an `agent_id` column is swept from the schema (`PURGE_KEEPS` names the
 *     ones that survive), AFTER the work spine, then the agent's `agent_<id>` budget row.
 *  5. `agents` goes LAST, when nothing references it any more.
 */
export function purgeAgentRows(agentId: string): PurgeCounts {
  const db = getDb();
  let counts: PurgeCounts = { messages: 0, workRows: 0, orphanedChildren: 0 };

  withUnit(() => {
    // 0. Every owner card this agent is the subject of ends, live, while its rows and name can
    //    still be read (t138 r6: a card whose subject is gone leaves; it never shows a raw id).
    agentPurgedForOwner(agentId);

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

    // 5. The work spine — no FK on `work.agent_id` at all (migration 135, PART 0 rider 1), so
    //    nothing in the database would ever do this.
    const workRows = deleteAllWorkForAgent(agentId);

    // 6. EVERY OTHER TABLE THAT NAMES THIS AGENT, found from the schema (see PURGE_KEEPS), after
    //    the work spine because `work.conversation_id` and `work.result_delivery_id` point INTO
    //    two of them. A SURVIVING agent's row that points at one of this agent's conversations
    //    or deliveries is nulled rather than left to fail the delete (the same lesser damage as
    //    `work.parent_id`); a delivery that is the evidence of a surviving DONE row is KEPT, by
    //    the guard trigger's own rule (migration 151): deleting it would make a closed task
    //    unprovable, and a purge that raises there would purge nothing.
    releaseWorkPointersIntoAgent(agentId);
    for (const table of agentOwnedTables()) {
      if (table === 'deliveries') deleteAgentDeliveries(agentId);
      else db.prepare(`DELETE FROM "${table}" WHERE agent_id = ?`).run(agentId);
    }

    // 7. Its budget row (keyed `agent_<id>`, so no `agent_id` column finds it), and the card
    //    that row's latch is holding: the card ends live, then the row goes.
    const budgetId = `agent_${agentId}`;
    const held = db.prepare('SELECT alert_words FROM budgets WHERE id = ?').get(budgetId) as { alert_words: string | null } | undefined;
    if (held?.alert_words) endBudgetCard(budgetId, held.alert_words);
    ownerConditionCleared(budgetStopKey(budgetId));
    db.prepare('DELETE FROM budgets WHERE id = ?').run(budgetId);

    // 8. The agent itself.
    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);

    counts = { messages, workRows, orphanedChildren };
  });

  return counts;
}
