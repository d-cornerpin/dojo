// T81c (NO-DOOMED-DIALS, Leg B) — census row 8: "Ollama concurrency lock ... no cap on
// concurrent requests to the same model (`existingSlot.activeRequests++`) ... this lock does
// not serialize or refuse it — it happily lets N concurrent prefills stack on the same GPU."
//
// The GPU livelock incident: the fast preempt/queued-wakeup loop (Leg B, `runtime.ts`) kept
// cold-redialing the SAME model while an earlier, still-processing attempt had never actually
// been told to stop server-side. This lock is the last line of defense — even if the engine
// above it redials, the GPU should only ever be asked to prefill ONE request per model at a
// time; everyone else queues.
//
// Every number below (declared patience, elapsed times) is a TEST FIXTURE, never a constant a
// real caller would be pinned to — this suite invents its own realistic-but-arbitrary values so
// it cannot be satisfied by accidentally matching a hardcoded implementation constant.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const PROVIDER = 'prov-fixture-77';
const MODEL = 'fixture-model-alpha';
const OTHER_MODEL = 'fixture-model-beta';

beforeEach(() => {
  // Fresh module registry per test: `ollama-lock.ts` is a process-wide singleton, and its
  // `slots`/`queue` are exactly the shared GPU-contention state this suite exercises. Without
  // this, one test's leftover slot state bleeds into the next and the failures stop meaning
  // what they say.
  vi.resetModules();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);');
  mockDb.current = db;
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('a same-model request queues behind a running one instead of stacking', () => {
  it('RED: a SECOND acquire for the SAME model does not resolve while the first is still active', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();

    await lock.acquire(PROVIDER, MODEL, 48_413); // arbitrary fixture patience, not a code constant

    let secondResolved = false;
    const second = lock.acquire(PROVIDER, MODEL, 48_413).then(() => { secondResolved = true; });

    // Give the microtask queue a chance to settle. At HEAD this resolves immediately
    // (`existingSlot.activeRequests++`) — that is exactly the defect.
    await Promise.resolve();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    lock.release(PROVIDER, MODEL);
    await second;
    expect(secondResolved).toBe(true);
    lock.release(PROVIDER, MODEL);
  });

  it('the second request proceeds the moment the first releases, and only one at a time', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();

    const order: string[] = [];
    await lock.acquire(PROVIDER, MODEL, 30_000);
    order.push('first-acquired');

    const secondDone = lock.acquire(PROVIDER, MODEL, 30_000).then(() => order.push('second-acquired'));
    const thirdDone = lock.acquire(PROVIDER, MODEL, 30_000).then(() => order.push('third-acquired'));

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first-acquired']); // neither waiter has proceeded yet

    lock.release(PROVIDER, MODEL); // frees the first
    await secondDone;
    expect(order).toEqual(['first-acquired', 'second-acquired']);
    // third still waiting — only one active at a time
    lock.release(PROVIDER, MODEL); // frees the second
    await thirdDone;
    expect(order).toEqual(['first-acquired', 'second-acquired', 'third-acquired']);
    lock.release(PROVIDER, MODEL);
  });

  it('CONTROL: cross-model behaviour on the same provider is unchanged — a different model still queues for a swap', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();

    await lock.acquire(PROVIDER, MODEL, 30_000);
    let otherResolved = false;
    const other = lock.acquire(PROVIDER, OTHER_MODEL, 30_000).then(() => { otherResolved = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(otherResolved).toBe(false); // the provider's one slot (default max=1) is busy

    lock.release(PROVIDER, MODEL);
    await other;
    expect(otherResolved).toBe(true);
    lock.release(PROVIDER, OTHER_MODEL);
  });

  it('CONTROL: two DIFFERENT providers never contend for each other\'s slot', async () => {
    const OTHER_PROVIDER = 'prov-fixture-88';
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();

    await lock.acquire(PROVIDER, MODEL, 30_000);
    let resolved = false;
    await lock.acquire(OTHER_PROVIDER, MODEL, 30_000).then(() => { resolved = true; });
    expect(resolved).toBe(true); // different provider, own slot pool, no wait at all
    lock.release(PROVIDER, MODEL);
    lock.release(OTHER_PROVIDER, MODEL);
  });

  it('a same-model queue wait is bounded by the RUNNING request\'s declared patience, not the flat 60s swap timeout', async () => {
    // Fixture: a declared patience far longer than the flat swap-queue timeout (60s) — the
    // exact "600s declared patience > QUEUE_TIMEOUT_MS=60s" shape the brief names, expressed
    // as an arbitrary fixture rather than either literal number.
    const declaredMs = 217_000;
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    await lock.acquire(PROVIDER, MODEL, declaredMs);
    let timedOut = false;
    let resolved = false;
    const waiter = lock.acquire(PROVIDER, MODEL, declaredMs)
      .then(() => { resolved = true; })
      .catch(() => { timedOut = true; });

    // Past the flat 60s cross-model swap timeout, but well inside the declared patience.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(timedOut, 'a queued same-model request must not starve at the flat 60s bound').toBe(false);
    expect(resolved).toBe(false);

    lock.release(PROVIDER, MODEL);
    await waiter;
    expect(resolved).toBe(true);
    lock.release(PROVIDER, MODEL);
  });

  it('a same-model queue wait DOES eventually time out, and names the real cause', async () => {
    const declaredMs = 88_000; // > the flat 60s floor, so the derived bound is what actually applies
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    await lock.acquire(PROVIDER, MODEL, declaredMs);
    let error: Error | undefined;
    const waiter = lock.acquire(PROVIDER, MODEL, declaredMs).catch((err: Error) => { error = err; });

    await vi.advanceTimersByTimeAsync(declaredMs + 5_000);
    await waiter;
    expect(error).toBeDefined();
    expect(error!.message).toContain('waiting behind a long prefill on the same model');
    lock.release(PROVIDER, MODEL);
  });

  it('CONTROL: with no declared patience supplied, the same-model queue still uses a sane bound (the flat swap timeout)', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    await lock.acquire(PROVIDER, MODEL); // no third argument
    let error: Error | undefined;
    const waiter = lock.acquire(PROVIDER, MODEL).catch((err: Error) => { error = err; });

    await vi.advanceTimersByTimeAsync(65_000); // past the flat 60s default
    await waiter;
    expect(error).toBeDefined();
    expect(error!.message).toContain('waiting behind a long prefill on the same model');
    lock.release(PROVIDER, MODEL);
  });
});
