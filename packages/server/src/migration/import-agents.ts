// ════════════════════════════════════════
// Migration Import — the agents an import stops, and bringing them back when it fails
// ════════════════════════════════════════
// Final round (owner rule: the Dojo does the work). The import closes the database to swap the data folder, so the
// runs in flight must stop first. They are STOPPED, never terminated: a termination is written into the very database
// a failed import puts back, so every agent used to come back terminated. When the import fails and its data is back,
// the agents it stopped carry on by themselves.

import { getDb } from '../db/connection.js';
import { stopAgent } from '../agent/runtime.js';
import { activeRuns, stoppedAgents, isStopFenced, queueSelfWake } from '../agent/shared-state.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-import');

/** The agents the OWNER stopped after this import began (`noteOwnerStop`, from the stop route). A failed import
 *  brings back only the agents it stopped itself, so these keep the owner's stop. */
const ownerStopsDuringImport = new Set<string>();
let importOpen = false;

/** Stop every run in flight before the database closes. Returns the agents the IMPORT stopped: a run the owner had
 *  already stopped (still unwinding, so still in `activeRuns`) is stopped again but not returned, because that stop
 *  is the owner's and a failed import must not lift it. */
export function stopAgentRunsForImport(): string[] {
  ownerStopsDuringImport.clear();
  importOpen = true;
  const all = [...activeRuns];
  const ownerStoppedAlready = new Set(all.filter((id) => isStopFenced(id)));   // the flag or the run's own fence
  for (const id of all) {
    try { stopAgent(id); } catch (e) { logger.warn('Could not stop a run before the import', { error: String(e) }, id); }
  }
  return all.filter((id) => !ownerStoppedAlready.has(id));
}

/** The owner pressed stop on this agent. Called by the stop route; while an import is open it keeps a failed
 *  import from lifting that stop. */
export function noteOwnerStop(id: string): void {
  if (importOpen) ownerStopsDuringImport.add(id);
}

/** The import failed and its data is back: lift the stop, clear the owner-stop marker it set (the owner did not stop
 *  these agents), and wake each to carry on. An agent the owner stopped during the import is left stopped. */
export function resumeAgentsAfterFailedImport(ids: readonly string[]): void {
  importOpen = false;
  const ownerStopped = new Set(ownerStopsDuringImport);
  ownerStopsDuringImport.clear();
  for (const id of ids.filter((x) => !ownerStopped.has(x))) {
    // Owner ruling: a failed import brings back by themselves only the agents it stopped (`stopAgentRunsForImport`
    // returns exactly those), so this clear never lifts a stop the owner pressed.
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
