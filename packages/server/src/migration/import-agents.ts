// ════════════════════════════════════════
// Migration Import — the agents an import stops, and bringing them back when it fails
// ════════════════════════════════════════
// Final round (owner rule: the Dojo does the work). The import closes the database to swap the data folder, so the
// runs in flight must stop first. They are STOPPED, never terminated: a termination is written into the very database
// a failed import puts back, so every agent used to come back terminated. When the import fails and its data is back,
// the agents it stopped carry on by themselves.

import { getDb } from '../db/connection.js';
import { stopAgent } from '../agent/runtime.js';
import { activeRuns, stoppedAgents, queueSelfWake } from '../agent/shared-state.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-import');

/** Stop every run in flight before the database closes. Returns the agents stopped. */
export function stopAgentRunsForImport(): string[] {
  const ids = [...activeRuns];
  for (const id of ids) {
    try { stopAgent(id); } catch (e) { logger.warn('Could not stop a run before the import', { error: String(e) }, id); }
  }
  return ids;
}

/** The import failed and its data is back: lift the stop, clear the owner-stop marker it set (the owner did not stop
 *  these agents), and wake each to carry on. */
export function resumeAgentsAfterFailedImport(ids: readonly string[]): void {
  for (const id of ids) {
    stoppedAgents.delete(id);
    try {
      const row = getDb().prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string | null } | undefined;
      if (row?.config) {
        const config = JSON.parse(row.config) as Record<string, unknown>;
        if ('stopMarkerPending' in config) {
          delete config.stopMarkerPending;
          getDb().prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(config), id);
        }
      }
    } catch (e) { logger.warn('Could not clear the import stop marker', { error: String(e) }, id); }
    queueSelfWake(id, 'import-failed-resume');
  }
}
