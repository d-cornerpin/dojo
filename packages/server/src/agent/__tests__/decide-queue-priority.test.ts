// ════════════════════════════════════════════════════════════════════════════
// v3.5 — decide()'s QUEUE, pinned here on its own: a WAITED caller goes before background asks, a stale
// background ask is dropped. The queue is module state, so every case lets all of its own work finish before
// it ends. No fake timers, no network — real promises, a gate to hold a turn, and a tick to let the pump settle.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { inTurn } from '../decide-queue.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

describe('decide-queue priority (waiter first, stale drop)', () => {
  it('guard: one turn at a time, in arrival order', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const bP = inTurn(null, async () => {
      log.push('b-start');
      return 'B';
    });
    await tick();
    expect(log).toEqual(['a-start']);
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await bP).toEqual({ left: false, value: 'B' });
    expect(log).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('guard: a throw releases the slot and reaches the caller', async () => {
    await expect(inTurn(null, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(inTurn(null, async () => 'next')).resolves.toEqual({ left: false, value: 'next' });
  });

  it('guard: a waiter that leaves while queued resolves left and never runs', async () => {
    const ctl = new AbortController();
    const log: string[] = [];
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; log.push('first'); return 1; });
    const second = inTurn(ctl.signal, async () => { log.push('second'); return 2; });
    const third = inTurn(null, async () => { log.push('third'); return 3; });
    await tick();
    ctl.abort();
    expect(await second).toEqual({ left: true });
    expect(log).toEqual([]);
    g.open();
    expect(await first).toEqual({ left: false, value: 1 });
    expect(await third).toEqual({ left: false, value: 3 });
    expect(log).toEqual(['first', 'third']);
  });

  it('guard: an already-aborted signal while the floor is held resolves left and never runs', async () => {
    const g = gate();
    const first = inTurn(null, async () => { await g.promise; return 1; });
    const ctl = new AbortController();
    ctl.abort();
    const second = inTurn(ctl.signal, async () => 2);
    await tick();
    expect(await second).toEqual({ left: true });
    g.open();
    await first;
  });

  it('guard: an abort after the turn began does not cancel running work', async () => {
    const ctl = new AbortController();
    await expect(inTurn(ctl.signal, async () => { ctl.abort(); return 'finished'; }))
      .resolves.toEqual({ left: false, value: 'finished' });
  });

  it('waiter first: a waited caller goes ahead of queued background asks', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const b1 = inTurn(null, async () => { log.push('b1-start'); return 'B1'; }, { background: true });
    const b2 = inTurn(null, async () => { log.push('b2-start'); return 'B2'; }, { background: true });
    const w = inTurn(null, async () => { log.push('w-start'); return 'W'; });
    await tick();
    expect(log).toEqual(['a-start']);
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await w).toEqual({ left: false, value: 'W' });
    expect(await b1).toEqual({ left: false, value: 'B1' });
    expect(await b2).toEqual({ left: false, value: 'B2' });
    expect(log).toEqual(['a-start', 'a-end', 'w-start', 'b1-start', 'b2-start']);
  });

  it('waited FIFO: waited callers keep their order, background goes after them', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const w1 = inTurn(null, async () => { log.push('w1-start'); return 'W1'; });
    const b = inTurn(null, async () => { log.push('b-start'); return 'B'; }, { background: true });
    const w2 = inTurn(null, async () => { log.push('w2-start'); return 'W2'; });
    await tick();
    expect(log).toEqual(['a-start']);
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await w1).toEqual({ left: false, value: 'W1' });
    expect(await w2).toEqual({ left: false, value: 'W2' });
    expect(await b).toEqual({ left: false, value: 'B' });
    expect(log).toEqual(['a-start', 'a-end', 'w1-start', 'w2-start', 'b-start']);
  });

  it('a running background ask is not pre-empted by a waited caller', async () => {
    const log: string[] = [];
    const g = gate();
    const bP = inTurn(null, async () => {
      log.push('b-start');
      await g.promise;
      log.push('b-end');
      return 'B';
    }, { background: true });
    await tick();
    expect(log).toEqual(['b-start']);
    const wP = inTurn(null, async () => { log.push('w-start'); return 'W'; });
    await tick();
    expect(log).toEqual(['b-start']);
    g.open();
    expect(await bP).toEqual({ left: false, value: 'B' });
    expect(await wP).toEqual({ left: false, value: 'W' });
    expect(log).toEqual(['b-start', 'b-end', 'w-start']);
  });

  it('stale drop: a stale background ask is dropped, the next one runs', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const sP = inTurn(null, async () => { log.push('s-start'); return 'S'; }, { background: true, stale: () => true });
    const nP = inTurn(null, async () => { log.push('n-start'); return 'N'; }, { background: true });
    await tick();
    expect(log).toEqual(['a-start']);
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await sP).toEqual({ left: true });
    expect(await nP).toEqual({ left: false, value: 'N' });
    expect(log).toEqual(['a-start', 'a-end', 'n-start']);
  });

  it('stale is read at turn time, not queue time: set true before the gate opens drops it', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    let stale = false;
    const sP = inTurn(null, async () => { log.push('s-start'); return 'S'; }, { background: true, stale: () => stale });
    await tick();
    stale = true;
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await sP).toEqual({ left: true });
    expect(log).toEqual(['a-start', 'a-end']);
  });

  it('stale is read at turn time: a flag still false when the gate opens runs the ask', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    let stale = false;
    const sP = inTurn(null, async () => { log.push('s-start'); return 'S'; }, { background: true, stale: () => stale });
    await tick();
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await sP).toEqual({ left: false, value: 'S' });
    expect(log).toEqual(['a-start', 'a-end', 's-start']);
  });

  it('a stale that throws counts as not stale: the ask runs', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const sP = inTurn(null, async () => { log.push('s-start'); return 'S'; }, {
      background: true, stale: () => { throw new Error('stale boom'); },
    });
    await tick();
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await sP).toEqual({ left: false, value: 'S' });
    expect(log).toEqual(['a-start', 'a-end', 's-start']);
  });

  it('a waited caller ignores stale and runs', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const wP = inTurn(null, async () => { log.push('w-start'); return 'W'; }, { stale: () => true });
    await tick();
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await wP).toEqual({ left: false, value: 'W' });
    expect(log).toEqual(['a-start', 'a-end', 'w-start']);
  });

  it('a background entry whose leave aborts while queued leaves at once and does not delay the others', async () => {
    const log: string[] = [];
    const g = gate();
    const aP = inTurn(null, async () => {
      log.push('a-start');
      await g.promise;
      log.push('a-end');
      return 'A';
    });
    const ctl = new AbortController();
    const bP = inTurn(ctl.signal, async () => { log.push('b-start'); return 'B'; }, { background: true });
    const nP = inTurn(null, async () => { log.push('n-start'); return 'N'; }, { background: true });
    await tick();
    ctl.abort();
    expect(await bP).toEqual({ left: true });
    expect(log).toEqual(['a-start']);
    g.open();
    expect(await aP).toEqual({ left: false, value: 'A' });
    expect(await nP).toEqual({ left: false, value: 'N' });
    expect(log).toEqual(['a-start', 'a-end', 'n-start']);
  });
});
