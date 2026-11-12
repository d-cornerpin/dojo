// `NO ACTION` FKs into `work(id)` fix the delete order; migration `172_orphaned_work_rows.sql` repeats it.

import { getDb } from '../db/connection.js';
import { clearReferencesToWork } from './work-refs.js';
import { withUnit } from '../db/unit.js';

/** Delete this agent's `work` rows; `work.agent_id` has no FK on purpose, so nothing else will. */
export function deleteAllWorkForAgent(agentId: string): number {
  const db = getDb();
  let removed = 0;
  withUnit(() => {
    clearReferencesToWork({ sql: 'SELECT id FROM work WHERE agent_id = ?', params: [agentId] });
    removed = db.prepare('DELETE FROM work WHERE agent_id = ?').run(agentId).changes;
  });
  return removed;
}

/** Release a surviving row's `NO ACTION` pointers into the purged agent's conversation and receipts. */
export function releaseWorkPointersIntoAgent(agentId: string): void {
  const db = getDb();
  db.prepare(`UPDATE work SET conversation_id = NULL
               WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)`).run(agentId);
  db.prepare(`UPDATE work SET result_delivery_id = NULL
               WHERE state != 'done' AND result_delivery_id IN (SELECT id FROM deliveries WHERE agent_id = ?)`).run(agentId);
}

/** The purged agent's receipts except a surviving `done` row's evidence (a trigger refuses that delete). */
export function deleteAgentDeliveries(agentId: string): void {
  getDb().prepare(`DELETE FROM deliveries WHERE agent_id = ?
               AND NOT EXISTS (SELECT 1 FROM work w WHERE w.result_delivery_id = deliveries.id AND w.state = 'done')`).run(agentId);
}
