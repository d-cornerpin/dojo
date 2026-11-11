// ONE transaction (`withUnit`): a part-way failure must never leave a half-purged agent.
// Explicit deletes, never `ON DELETE CASCADE`: FK enforcement is a per-connection pragma.

import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { deleteAllForAgent, deleteAgentBusRowsFor } from '../memory/message-store.js';
import { deleteAllWorkForAgent, releaseWorkPointersIntoAgent, deleteAgentDeliveries } from '../work/purge-sweep.js';
import { agentPurgedForOwner } from './agent-owner-cards.js';
import { endBudgetCard } from '../costs/budget-cards.js';
import { budgetStopKey, ownerConditionCleared } from '../healer/owner-notices.js';

// Every table with an `agent_id` column is swept, read from the live schema; only tables
// named in `PURGE_KEEPS` survive. Keeping one is a deliberate edit in that record.
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

export interface PurgeCounts {
  readonly messages: number;
  readonly workRows: number;
  readonly orphanedChildren: number;
}

/** Rows only; the caller owns the gates (not the primary, terminated, exists). This owns
 *  the rows, in FK order, agents LAST when nothing references it any more. */
export function purgeAgentRows(agentId: string): PurgeCounts {
  const db = getDb();
  let counts: PurgeCounts = { messages: 0, workRows: 0, orphanedChildren: 0 };

  withUnit(() => {
    // Ends owner cards while the agent's rows and name can still be read: a card shows no raw id.
    agentPurgedForOwner(agentId);

    // Children survive, the link does not: null it before the agent row (self-FK).
    const orphanedChildren = db.prepare(
      'UPDATE agents SET parent_agent = NULL WHERE parent_agent = ?',
    ).run(agentId).changes;

    const messages = deleteAllForAgent(agentId);
    deleteAgentBusRowsFor(agentId);

    db.prepare(
      'DELETE FROM summary_messages WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)',
    ).run(agentId);
    db.prepare(
      `DELETE FROM summary_parents
        WHERE summary_id IN (SELECT id FROM summaries WHERE agent_id = ?)
           OR parent_id  IN (SELECT id FROM summaries WHERE agent_id = ?)`,
    ).run(agentId, agentId);
    db.prepare('DELETE FROM summaries WHERE agent_id = ?').run(agentId);

    const workRows = deleteAllWorkForAgent(agentId);

    // Release work pointers BEFORE the sweep: work rows point INTO two of the swept tables.
    releaseWorkPointersIntoAgent(agentId);
    for (const table of agentOwnedTables()) {
      if (table === 'deliveries') deleteAgentDeliveries(agentId);
      else db.prepare(`DELETE FROM "${table}" WHERE agent_id = ?`).run(agentId);
    }

    const budgetId = `agent_${agentId}`;
    endBudgetCard(budgetId);
    ownerConditionCleared(budgetStopKey(budgetId));
    db.prepare('DELETE FROM budgets WHERE id = ?').run(budgetId);

    db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);

    counts = { messages, workRows, orphanedChildren };
  });

  return counts;
}
