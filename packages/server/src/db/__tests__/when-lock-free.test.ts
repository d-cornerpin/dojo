// whenLockFree — the park whose one wake is a pass landing (v3.5 D18 r5).
//
// A compaction job that finds `compact:<agentId>` held parks on `whenLockFree`;
// its one wake is that pass landing. So the contract is precise: it must
// resolve at once when the key is idle, wait through the holder AND every
// queued follower (the wake is the whole chain draining), never reject just
// because a holder threw, ignore unrelated keys, and leave the key clean for
// the next `{ifBusy:'skip'}` caller.
//
// Like with-lock.test.ts everything here is in-process and deterministic. No
// fake timers: the one pending-state case waits a small real 10 ms, and the
// order cases assert observed ORDER, never elapsed time.

import { describe, it, expect } from 'vitest';
import { withLock, whenLockFree } from '../with-lock.js';

/** A promise plus its resolver, so a test can hold a critical section open. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

/** Let the microtask queue drain so any already-runnable continuation runs. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('whenLockFree', () => {
  it('resolves at once when nobody holds the key', async () => {
    await whenLockFree('wlf-idle');
  });

  it('waits for the holder, then resolves after it releases', async () => {
    const gate = deferred();
    const held = withLock('wlf-held', () => gate.promise);

    let free = false;
    const w = whenLockFree('wlf-held').then(() => { free = true; });
    await settle();

    // A small real wait: the park must still be pending over a running pass.
    await new Promise(r => setTimeout(r, 10));
    expect(free).toBe(false);

    gate.resolve();
    await w;
    expect(free).toBe(true);
    await held;
  });

  it('waits for a queued follower too — the wake is the whole chain draining', async () => {
    const order: string[] = [];
    const gate = deferred();
    const a = withLock('wlf-queue', () => gate.promise);
    const b = withLock('wlf-queue', async () => { order.push('B'); });
    const w = whenLockFree('wlf-queue').then(() => { order.push('free'); });

    gate.resolve();
    await Promise.all([a, b, w]);
    expect(order).toEqual(['B', 'free']);
  });

  it('a throwing holder does not make the park reject', async () => {
    const bad = withLock('wlf-fail', async () => { throw new Error('x'); });
    bad.catch(() => undefined);
    await expect(whenLockFree('wlf-fail')).resolves.toBeUndefined();
  });

  it('other keys are not waited on', async () => {
    const gate = deferred();
    const held = withLock('wlf-a', () => gate.promise);

    // wlf-b is free, so the park resolves at once even while wlf-a is held.
    await whenLockFree('wlf-b');

    gate.resolve();
    await held;
  });

  it('the key is cleaned afterwards — a later {ifBusy:\'skip\'} caller runs', async () => {
    // Deterministic on its own hold+release of the same key case 3 used:
    // once the holder releases, the key must leave the table, so a skip caller
    // runs instead of silently returning undefined.
    const gate = deferred();
    const held = withLock('wlf-queue', () => gate.promise);
    gate.resolve();
    await held;
    await settle();

    await expect(withLock('wlf-queue', async () => 'ran', { ifBusy: 'skip' })).resolves.toBe('ran');
  });
});
