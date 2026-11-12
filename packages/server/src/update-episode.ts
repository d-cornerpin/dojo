import { readMarker, type UpdateMarker } from './update-state.js';

export function episodeSummary(): Pick<UpdateMarker, 'phase' | 'targetVersion' | 'previousVersion' | 'failedReason'> | null {
  const m = readMarker();
  return m && m.phase !== 'idle' ? { phase: m.phase, targetVersion: m.targetVersion, previousVersion: m.previousVersion, failedReason: m.failedReason } : null;
}
