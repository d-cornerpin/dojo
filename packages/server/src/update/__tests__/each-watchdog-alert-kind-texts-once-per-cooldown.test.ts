// Each watchdog alert kind claims one text, then waits out its cooldown. Which kinds exist is the `AlertKey` type's job:
// a key outside it does not compile at `claimAlert`.
import { describe, it, expect } from 'vitest';
import { claimAlert, emptyState, type AlertKey } from '../../../../../watchdog/src/alert-ledger.js';

const KINDS: readonly AlertKey[] = [
  'platform_down', 'platform_missing', 'platform_restart_failed', 'auto_rollback', 'auto_rollback_failed',
  'memory_low', 'disk_low', 'db_integrity',
];

describe('each watchdog alert kind texts once per cooldown', () => {
  it('each kind in the set claims one text, then waits out its cooldown', () => {
    const state = emptyState();
    for (const kind of KINDS) {
      expect(claimAlert(state, kind, '+15550100', 1_000), kind).toBe(true);
      expect(claimAlert(state, kind, '+15550100', 2_000), kind).toBe(false);
    }
    expect(Object.keys(state.alertState).sort()).toEqual([...KINDS].sort());
  });
});
