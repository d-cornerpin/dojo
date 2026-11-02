// ════════════════════════════════════════════════════════════════════════════
// THE ONE decide() QUEUE — `inTurn` (`../decide-queue.js`). No test referenced
// it (searched `*.test.ts`; only `decide.test.ts` exercises decide() itself),
// and a mistake here silently serialises or wedges every decide() call. Six
// clauses pin the queue's contract, each with real promises — no fake timers.
//
// THE QUEUE (t268/t274 fix rounds): the local Ollama answers one request at a
// time, so decide() calls go one after another. A slot is released however its
// call ends, a throw included; a waiter whose `leave` signal aborts stops
// waiting without running its work and without blocking the callers behind it.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { aheadOfAWaiterMs, inTurn } from '../decide-queue.js';

/** Let the queue's pending microtasks run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A promise the test opens when it chooses. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

describe('inTurn — the one decide() queue', () => {
  it('runs callers one after another: the next call waits until the floor frees', async () => {
    const g = gate();
    const log: string[] = [];
    const a = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const b = inTurn(null, async () => {
      log.push('b-start');
      return 'B';
    });

    await tick();
    expect(log).toEqual(['a-start']);   // B has not run: A still holds the floor

    g.open();
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult).toEqual({ left: false, value: 'A' });
    expect(bResult).toEqual({ left: false, value: 'B' });
    expect(log).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('releases a slot even when the work throws', async () => {
    await expect(inTurn(null, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    await expect(inTurn(null, async () => 'next'))
      .resolves.toEqual({ left: false, value: 'next' });
  });

  it('a waiter whose signal aborts leaves without running, without blocking the callers behind it', async () => {
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; return 'first'; });
    const ctl = new AbortController();
    const log: string[] = [];
    const second = inTurn(ctl.signal, async () => { log.push('leaver'); return 'second'; });
    const third = inTurn(null, async () => 3);

    await tick();
    ctl.abort();
    await expect(second).resolves.toEqual({ left: true });
    expect(log).toEqual([]);           // 'leaver' never ran

    g.open();
    await expect(first).resolves.toEqual({ left: false, value: 'first' });
    await expect(third).resolves.toEqual({ left: false, value: 3 });
  });

  it('an already-aborted signal leaves at once while the floor is held, and its work never runs', async () => {
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; return 'first'; });
    const ctl = new AbortController();
    ctl.abort();
    const log: string[] = [];
    const second = inTurn(ctl.signal, async () => { log.push('never'); return 'x'; });

    await expect(second).resolves.toEqual({ left: true });
    expect(log).toEqual([]);

    g.open();
    await expect(first).resolves.toEqual({ left: false, value: 'first' });
    await tick();                     // let the queue tail settle before the next case
  });

  it('a waiter with a signal that is never aborted runs once the floor frees', async () => {
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; return 'first'; });
    const ctl = new AbortController();
    const second = inTurn(ctl.signal, async () => 'ran');

    await tick();
    g.open();
    await expect(first).resolves.toEqual({ left: false, value: 'first' });
    await expect(second).resolves.toEqual({ left: false, value: 'ran' });
  });

  it('an abort after the turn began does not cancel the running work', async () => {
    const ctl = new AbortController();
    await expect(inTurn(ctl.signal, async () => {
      ctl.abort();
      return 'finished';
    })).resolves.toEqual({ left: false, value: 'finished' });
  });

  it('proof-fix N: an allowance that throws counts as 0 — the queue never wedges and the next ask is served', async () => {
    const boom = (): number => { throw new Error('allowance failed'); };
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; return 'first'; }, { allowedMs: boom });
    await tick();
    const second = inTurn(null, async () => 'second', { allowedMs: boom });
    await tick();
    expect(aheadOfAWaiterMs()).toBe(0);   // neither the call in flight's nor the queued waiter's allowance throws out
    g.open();
    await expect(first).resolves.toEqual({ left: false, value: 'first' });
    await expect(second).resolves.toEqual({ left: false, value: 'second' });
    await expect(inTurn(null, async () => 'third')).resolves.toEqual({ left: false, value: 'third' });
  });
});
