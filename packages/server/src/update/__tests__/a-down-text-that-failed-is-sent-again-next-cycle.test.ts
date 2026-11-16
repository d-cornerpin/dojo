// A "DOWN" text that Messages failed to send is not recorded as told: the next check sends it again.
import { describe, it, expect } from 'vitest';
import { emptyState, sendAlert, sendRecovery } from '../../../../../watchdog/src/alert-ledger.js';

const OWNER = '+15550100';

describe('a down text that failed is sent again next cycle', () => {
  it('a failed send leaves the alert unclaimed, and the next check sends it', () => {
    const state = emptyState();
    const sent: string[] = [];
    const failing = () => false;
    const working = (_to: string, text: string) => { sent.push(text); return true; };

    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', failing, 1_000)).toBe(false);
    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', working, 121_000)).toBe(true);
    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', working, 241_000), 'told once, then the cooldown').toBe(false);
    expect(sent).toEqual(['DOWN']);
  });

  it('a failed recovery text keeps the alert active, so the next check sends it', () => {
    const state = emptyState();
    sendAlert(state, 'platform_down', OWNER, 'DOWN', () => true, 1_000);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => false)).toBe(false);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => true)).toBe(true);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => true), 'one recovery per incident').toBe(false);
  });
});
