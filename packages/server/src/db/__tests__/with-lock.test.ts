// PHASE-1 T2 Step 1 — the platform's first mutual-exclusion primitive.
//
// Until now there was none. The duplicate-summary race (research 22: 11.4% of
// depth-0 summaries, 44/387) existed because two compaction runs for the same
// agent could interleave freely. `withLock` is the single-process primitive
// that makes that impossible, and this file is its contract.
//
// Everything here is in-process and deterministic: no database, no timers that
// matter, no model. The lock serialises PROMISES, so the assertions are about
// observed ORDER and observed OVERLAP, never about elapsed time.

import { describe, it, expect, beforeEach } from 'vitest';
import { withLock } from '../with-lock.js';

/** A promise plus its resolver, so a test can hold a critical section open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Let the microtask queue drain so any already-runnable continuation runs. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('withLock', () => {
  let key: string;
  beforeEach(() => {
    // A fresh key per test: the lock map is module-level by design (one
    // process, one set of chains), so tests must not share keys.
    key = `compact:agent-${Math.random().toString(36).slice(2)}`;
  });

  it('serialises two concurrent calls on the same key — the second WAITS, it does not interleave', async () => {
    const order: string[] = [];
    const first = deferred();

    const a = withLock(key, async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
      return 'a';
    });

    const b = withLock(key, async () => {
      order.push('b:start');
      return 'b';
    });

    // A is inside its critical section and B has not started: no interleave.
    await settle();
    expect(order).toEqual(['a:start']);

    first.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
  });

  it("{ifBusy:'skip'} returns undefined WITHOUT running fn while the key is held", async () => {
    const first = deferred();
    let secondRan = false;

    const a = withLock(key, async () => { await first.promise; return 'a'; });
    await settle();

    const b = await withLock(key, async () => { secondRan = true; return 'b'; }, { ifBusy: 'skip' });

    expect(b).toBeUndefined();
    expect(secondRan).toBe(false);

    first.resolve();
    await expect(a).resolves.toBe('a');
  });

  it("{ifBusy:'skip'} RUNS once the key is free again — the lock releases, it does not latch", async () => {
    // The requirement this guards: adoption at checkAndCompact uses
    // ifBusy:'skip'. A lock that never frees its key turns every compaction
    // after the first into a silent no-op for the life of the process —
    // the agent stops compacting and nothing errors.
    const firstResult = await withLock(key, async () => 'first', { ifBusy: 'skip' });
    expect(firstResult).toBe('first');

    await settle();

    let secondRan = false;
    const secondResult = await withLock(key, async () => { secondRan = true; return 'second'; }, { ifBusy: 'skip' });

    expect(secondRan).toBe(true);
    expect(secondResult).toBe('second');

    // And a third, because "works twice" is not the same as "works forever".
    const thirdResult = await withLock(key, async () => 'third', { ifBusy: 'skip' });
    expect(thirdResult).toBe('third');
  });

  it('a throwing fn RELEASES the lock — the waiter still runs, and the throw reaches its own caller', async () => {
    const order: string[] = [];
    const first = deferred();

    const a = withLock(key, async () => {
      order.push('a:start');
      await first.promise;
      throw new Error('boom');
    });

    const b = withLock(key, async () => { order.push('b:start'); return 'b'; });

    await settle();
    expect(order).toEqual(['a:start']);

    first.resolve();
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('b');
    expect(order).toEqual(['a:start', 'b:start']);
  });

  it("a throwing fn also frees the key for a later {ifBusy:'skip'} caller", async () => {
    await expect(withLock(key, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await settle();
    await expect(withLock(key, async () => 'after', { ifBusy: 'skip' })).resolves.toBe('after');
  });

  it('different keys do NOT serialise — they run concurrently', async () => {
    const gate = deferred();
    const order: string[] = [];

    const a = withLock(`${key}:A`, async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
      return 'a';
    });

    const b = withLock(`${key}:B`, async () => {
      order.push('b:start');
      return 'b';
    });

    // B ran to completion while A is still holding its own key.
    await settle();
    expect(order).toEqual(['a:start', 'b:start']);
    await expect(b).resolves.toBe('b');

    gate.resolve();
    await expect(a).resolves.toBe('a');
    expect(order).toEqual(['a:start', 'b:start', 'a:end']);
  });

  it('three waiters on one key run in arrival order, one at a time', async () => {
    const order: string[] = [];
    const inside: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const runs = ['x', 'y', 'z'].map((name, i) => withLock(key, async () => {
      inside.push(name);
      expect(inside.length).toBe(1);          // never two inside at once
      order.push(`${name}:start`);
      await gates[i].promise;
      order.push(`${name}:end`);
      inside.pop();
      return name;
    }));

    await settle();
    expect(order).toEqual(['x:start']);
    gates[0].resolve(); await settle();
    expect(order).toEqual(['x:start', 'x:end', 'y:start']);
    gates[1].resolve(); await settle();
    expect(order).toEqual(['x:start', 'x:end', 'y:start', 'y:end', 'z:start']);
    gates[2].resolve();

    await expect(Promise.all(runs)).resolves.toEqual(['x', 'y', 'z']);
  });

  it("{ifBusy:'wait'} is the explicit spelling of the default and waits, never skips", async () => {
    const order: string[] = [];
    const first = deferred();

    const a = withLock(key, async () => { order.push('a:start'); await first.promise; order.push('a:end'); return 'a'; });
    await settle();
    const b = withLock(key, async () => { order.push('b:start'); return 'b'; }, { ifBusy: 'wait' });

    await settle();
    expect(order).toEqual(['a:start']);
    first.resolve();

    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });
});
