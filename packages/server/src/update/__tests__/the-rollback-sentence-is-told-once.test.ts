// rollback.sh's outcome sentence is told once: retried after a failed send, but after three failures in a
// row it counts as told. Only a restored build already healthy makes it the check's one "back" text.
import { describe, it, expect } from 'vitest';
import { emptyState, tellRollbackOutcome, tellBack, SEND_TRIES } from '../../../../../watchdog/src/alert-ledger.js';

const OWNER = '+15550100';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

describe('the rollback sentence is told once', () => {
  it('failed sends are retried, and after three in a row it counts as told', () => {
    const state = emptyState();
    let tries = 0;
    const failing = () => { tries++; return false; };
    const told = [1, 2, 3].map(() => tellRollbackOutcome(state, 'restored', 'put back', OWNER, failing, false, NOW));
    expect(told).toEqual([false, false, true]);
    expect(tries).toBe(SEND_TRIES);
  });

  it('a restored build already healthy owes no later back text', () => {
    const state = emptyState();
    tellRollbackOutcome(state, 'restored', 'put back', OWNER, () => true, true, NOW);
    const sent: string[] = [];
    tellBack(state, OWNER, (_to, t) => { sent.push(t); return true; }, true);
    expect(sent).toEqual([]);
  });

  it('after a refused or broken rollback he is told once that Dojo runs again', () => {
    for (const kind of ['unchanged', 'failed']) {
      const state = emptyState();
      tellRollbackOutcome(state, kind, 'could not be undone', OWNER, () => true, true, NOW);
      const sent: string[] = [];
      tellBack(state, OWNER, (_to, t) => { sent.push(t); return true; }, false);
      expect(sent, kind).toEqual([expect.stringContaining('running again')]);
    }
  });
});
