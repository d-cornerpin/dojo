import { describe, it, expect } from 'vitest';
import * as L from '../../../../../watchdog/src/alert-ledger.js';

describe('watchdog alert is not spent before it has anyone to go to', () => {
  it('a recipient-less claim returns false and leaves the ledger untouched', () => {
    const s = L.emptyState();
    expect((L as any).claimAlert(s, 'platform_down', '')).toBe(false);
    expect(s.alertState).toEqual({});
  });

  it('a later claim with a recipient is not blocked by the earlier empty one', () => {
    const s = L.emptyState();
    (L as any).claimAlert(s, 'platform_down', '');
    expect((L as any).claimAlert(s, 'platform_down', '+15550100')).toBe(true);
  });

  it('a second claim with a recipient inside the cooldown is suppressed', () => {
    const s = L.emptyState();
    const t0 = 1_000_000;
    expect((L as any).claimAlert(s, 'platform_down', '+15550100', t0)).toBe(true);
    expect((L as any).claimAlert(s, 'platform_down', '+15550100', t0 + 1000)).toBe(false);
  });

  it('after a recipient-less claim nothing is active, so no orphan recovery', () => {
    const s = L.emptyState();
    (L as any).claimAlert(s, 'platform_down', '');
    expect(L.markAlertResolved(s, 'platform_down')).toBe(false);
  });
});
