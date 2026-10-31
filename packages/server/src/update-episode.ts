// The plain summary of the current update/rollback episode that the version route hands a page
// waiting for a restart, so it can tell "still starting" from "the new build failed". Null when idle.
import { readMarker, type UpdateMarker } from './update-state.js';

export function episodeSummary(): Pick<UpdateMarker, 'phase' | 'targetVersion' | 'previousVersion' | 'failedReason'> | null {
  const m = readMarker();
  return m && m.phase !== 'idle' ? { phase: m.phase, targetVersion: m.targetVersion, previousVersion: m.previousVersion, failedReason: m.failedReason } : null;
}
