// A failed update is told once: after its text the generic "DOWN" and "restart did not help" texts stay quiet
// until Dojo runs again. A rollback that worked gets its one "it worked" text when Dojo is healthy again.
import { describe, it, expect } from 'vitest';
import { emptyState, sendAlert, sendRecovery } from '../../../../../watchdog/src/alert-ledger.js';
import { updateOwnsOutage, type UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const OWNER = '+15550100';
const failed: UpdateMarker = {
  phase: 'failed-permanently', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 3, firstBootAt: new Date(NOW - 3_600_000).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 1, migrationsRanDuringEpisode: false, dataBackup: null, failedReason: 'exhausted', writeSeq: 4,
  updatedAt: new Date(NOW).toISOString(),
};

describe('one text for a failed update and one when rollback worked', () => {
  it('after the failed-update text the generic down texts wait until Dojo runs again', () => {
    const state = emptyState();
    expect(updateOwnsOutage(failed, state.alertState, NOW), 'not told yet: the generic text is the fallback').toBe(false);
    sendAlert(state, 'auto_rollback_failed', OWNER, 'update failed', () => true, NOW);
    expect(updateOwnsOutage(failed, state.alertState, NOW + 4 * 3_600_000)).toBe(true);
    expect(sendRecovery(state, 'auto_rollback_failed', OWNER, 'running again', () => true)).toBe(true);
    expect(updateOwnsOutage(failed, state.alertState, NOW + 5 * 3_600_000), 'a later outage is texted as usual').toBe(false);
  });

  it('a rollback that worked is told once more when Dojo is healthy again', () => {
    const state = emptyState();
    const sent: string[] = [];
    const send = (_to: string, text: string) => { sent.push(text); return true; };
    sendAlert(state, 'auto_rollback', OWNER, 'put back', send, NOW);
    sendRecovery(state, 'auto_rollback', OWNER, 'it worked', send);
    sendRecovery(state, 'auto_rollback', OWNER, 'it worked', send);
    expect(sent).toEqual(['put back', 'it worked']);
  });
});
