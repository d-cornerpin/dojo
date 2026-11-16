// A "DOWN" text that Messages failed to send is not recorded as told: the next check sends it again,
// up to three tries in a row, after which it counts as told (a slow Messages may have delivered it).
import { describe, it, expect } from 'vitest';
import { emptyState, sendAlert, sendRecovery, SEND_TRIES } from '../../../../../watchdog/src/alert-ledger.js';

const OWNER = '+15550100';

describe('a down text that failed is sent again next cycle', () => {
  it('a failed send leaves the alert unclaimed, and the next check sends it', () => {
    const state = emptyState();
    const sent: string[] = [];
    const working = (_to: string, text: string) => { sent.push(text); return true; };

    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', () => false, 1_000)).toBe(false);
    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', working, 121_000)).toBe(true);
    expect(sendAlert(state, 'platform_down', OWNER, 'DOWN', working, 241_000), 'told once, then the cooldown').toBe(false);
    expect(sent).toEqual(['DOWN']);
  });

  it('after three failed sends in a row the text counts as told and waits out the cooldown', () => {
    const state = emptyState();
    let tries = 0;
    const failing = () => { tries++; return false; };
    for (let i = 0; i < 6; i++) sendAlert(state, 'platform_down', OWNER, 'DOWN', failing, 1_000 + i * 120_000);
    expect(tries).toBe(SEND_TRIES);
    expect(state.alertState.platform_down?.active).toBe(true);
  });

  it('a failed recovery text keeps the alert active, so the next check sends it', () => {
    const state = emptyState();
    sendAlert(state, 'platform_down', OWNER, 'DOWN', () => true, 1_000);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => false)).toBe(false);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => true)).toBe(true);
    expect(sendRecovery(state, 'platform_down', OWNER, 'UP', () => true), 'one recovery per incident').toBe(false);
  });
});
