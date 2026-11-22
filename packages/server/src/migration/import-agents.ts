// Migration import: stops the agents an import interrupts and resumes them if it fails. They are
// stopped, never terminated (a termination would be written into the database a failed import puts back).

import { stopAgent } from '../agent/runtime.js';
import { activeRuns, stoppedAgents, isStopFenced, queueSelfWake } from '../agent/shared-state.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-import');

/** Agents the OWNER stopped after the import began; a failed import must not lift these. */
const ownerStopsDuringImport = new Set<string>();
let importOpen = false;

/** Stop every run before the database closes; returns only the agents the IMPORT stopped (a run the owner
 *  already stopped is stopped again but not returned). */
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

/** The owner pressed stop (called by the stop route); noted while an import is open. */
export function noteOwnerStop(id: string): void {
  if (importOpen) ownerStopsDuringImport.add(id);
}

/** The import failed and its data is back: lift its stops and wake each agent; owner-stopped ones stay stopped. */
export function resumeAgentsAfterFailedImport(ids: readonly string[]): void {
  importOpen = false;
  const ownerStopped = new Set(ownerStopsDuringImport);
  ownerStopsDuringImport.clear();
  for (const id of ids.filter((x) => !ownerStopped.has(x))) {
    stoppedAgents.delete(id);
    queueSelfWake(id, 'import-failed-resume');
  }
}
