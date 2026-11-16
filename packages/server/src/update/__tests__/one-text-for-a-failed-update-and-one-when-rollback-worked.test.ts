// A failed update is told once: after its text the generic outage texts stay quiet until Dojo runs again.
// At a healthy check the owner gets at most one "back" text, the most specific one that is due.
import { describe, it, expect } from 'vitest';
import { emptyState, sendAlert, outageTexts, tellBack, type AlertKey } from '../../../../../watchdog/src/alert-ledger.js';
import { type UpdateMarker } from '../../../../../watchdog/src/auto-rollback.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const OWNER = '+15550100';
const failed: UpdateMarker = {
  phase: 'failed-permanently', targetVersion: '3.5.0', previousVersion: '3.4.1', backupDir: '/b', stagingDir: null,
  bootAttempts: 3, firstBootAt: new Date(NOW - 3_600_000).toISOString(), lastBootAt: null, confirmedHealthyAt: null,
  rollbackCount: 1, migrationsRanDuringEpisode: false, dataBackup: null, failedReason: 'exhausted', writeSeq: 4,
  updatedAt: new Date(NOW).toISOString(),
};
const DOWN = { failures: 6, sinceRestart: 2, restarts: 1 };

function healthyCheck(active: AlertKey[], alreadyTold = false): string[] {
  const state = emptyState();
  for (const key of active) sendAlert(state, key, OWNER, key, () => true, NOW);
  const sent: string[] = [];
  tellBack(state, OWNER, (_to, text) => { sent.push(text); return true; }, alreadyTold);
  expect(Object.values(state.alertState).some((e) => e.active), 'every outage alert is retired').toBe(false);
  return sent;
}

describe('one text for a failed update and one when rollback worked', () => {
  it('after the failed-update text the generic outage texts wait until Dojo runs again', () => {
    const state = emptyState();
    expect(outageTexts(state, failed, NOW, DOWN).length, 'not told yet: the generic text is the fallback').toBe(2);
    sendAlert(state, 'auto_rollback_failed', OWNER, 'update failed', () => true, NOW);
    expect(outageTexts(state, failed, NOW + 4 * 3_600_000, DOWN)).toEqual([]);
    tellBack(state, OWNER, () => true, false);
    expect(outageTexts(state, failed, NOW + 5 * 3_600_000, DOWN).length, 'a later outage is texted as usual').toBe(2);
  });

  it('a healthy check sends at most one back text, the most specific that is due', () => {
    expect(healthyCheck(['platform_down', 'auto_rollback'])).toEqual([expect.stringContaining('the rollback worked')]);
    expect(healthyCheck(['auto_rollback', 'auto_rollback_failed', 'platform_down', 'platform_restart_failed']))
      .toEqual([expect.stringContaining('running again and the box is healthy')]);
    expect(healthyCheck(['platform_down', 'platform_restart_failed'])).toEqual([expect.stringContaining('back UP')]);
  });

  it('when the rollback sentence was told at this healthy check, nothing more is sent', () => {
    expect(healthyCheck(['platform_down'], true)).toEqual([]);
  });

  it('a failed back text retires nothing, so the next check tries again', () => {
    const state = emptyState();
    sendAlert(state, 'platform_down', OWNER, 'DOWN', () => true, NOW);
    tellBack(state, OWNER, () => false, false);
    expect(state.alertState.platform_down?.active).toBe(true);
  });
});
