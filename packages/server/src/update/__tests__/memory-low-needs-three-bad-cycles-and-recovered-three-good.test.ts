// A reading near the memory line does not flap: "low" needs three bad checks in a row, "recovered" three good ones.
import { describe, it, expect } from 'vitest';
import { emptyState, readLevel, sendAlert, sendRecovery } from '../../../../../watchdog/src/alert-ledger.js';

describe('memory low needs three bad cycles and recovered three good', () => {
  it('texts low after three bad checks and recovered after three good, and nothing for a flapping reading', () => {
    const state = emptyState();
    const runs: Record<string, number> = {};
    const sent: string[] = [];
    const send = (_to: string, text: string) => { sent.push(text); return true; };
    const check = (bad: boolean) => {
      const level = readLevel(runs, 'memory_low', bad);
      if (level === 'low') sendAlert(state, 'memory_low', '+15550100', 'low', send, 1_000);
      if (level === 'ok') sendRecovery(state, 'memory_low', '+15550100', 'recovered', send);
      return level;
    };

    for (const bad of [true, false, true, true, false, true, false]) check(bad);
    expect(sent, 'a reading that flips every check is never texted').toEqual([]);

    expect([check(true), check(true), check(true)]).toEqual([null, null, 'low']);
    check(true);
    expect(sent).toEqual(['low']);

    check(false); check(false);
    expect(sent, 'two good checks are not yet a recovery').toEqual(['low']);
    check(false); check(false);
    expect(sent).toEqual(['low', 'recovered']);
  });
});
