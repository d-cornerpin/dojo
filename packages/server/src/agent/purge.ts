// ── EVERYTHING AN AGENT OWNS, DELETED IN ONE UNIT ──
// `POST /api/agents/:id/purge` used to carry a hand-written delete list with no completeness check,
// and it was wrong twice over: purging a parent, or an agent with a `briefings` row, RAISED on a
// foreign key, and every per-agent table added later became an orphan class. This module owns the
// sequence now, in ONE transaction (`withUnit`), so a failure part-way cannot leave a half-purged
// agent, and so the FK order below is a guarantee rather than a hope.
//
// Explicit deletes never lean on `ON DELETE CASCADE`: FK enforcement is a per-connection pragma,
// OFF for the migration chain and for every `sqlite3` CLI writer, and a statement that is only
// correct while somebody else's pragma is set is not correct (migration 173 sweeps the rows that
// hole minted).

import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { deleteAllForAgent, deleteAgentBusRowsFor } from '../memory/message-store.js';
import { deleteAllWorkForAgent, releaseWorkPointersIntoAgent, deleteAgentDeliveries } from '../work/purge-sweep.js';
import { agentPurgedForOwner } from './agent-owner-cards.js';
import { endBudgetCard } from '../costs/budget-cards.js';
import { budgetStopKey, ownerConditionCleared } from '../healer/owner-notices.js';

// ── WHAT A PURGE KEEPS, AND NOTHING ELSE (t189 B4, owner decision 28) ──
// "Keep the purged agent's SPENDING history; remove everything else." Every table with an
// `agent_id` column is swept, found from the schema each time (25 tables plus the budget row were
// being left behind), and only the tables named HERE survive, each with its reason. A new
// per-agent table is swept the day its migration lands; keeping one is a deliberate edit here, and
// `__tests__/t189-purge-sweeps-every-agent-table.test.ts` fails on any other outcome.
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

    // 6. EVERY OTHER TABLE THAT NAMES THIS AGENT (see PURGE_KEEPS), after the work spine because
    //    `work` points INTO two of them, so surviving rows' pointers are released first.
    releaseWorkPointersIntoAgent(agentId);
    for (const table of agentOwnedTables()) {
      if (table === 'deliveries') deleteAgentDeliveries(agentId);
      else db.prepare(`DELETE FROM "${table}" WHERE agent_id = ?`).run(agentId);
    }

    // 7. Its budget row (keyed `agent_<id>`: no `agent_id` column finds it) and the card it holds.
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
