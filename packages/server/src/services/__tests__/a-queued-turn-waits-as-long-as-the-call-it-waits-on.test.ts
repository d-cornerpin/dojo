// ════════════════════════════════════════════════════════════════════════════════════
// t114 (CENSUS ROW 8) — A QUEUED TURN WAITS AS LONG AS THE CALL IT IS WAITING ON.
//
// Two numbers that were always meant to be the same one had drifted apart.
//
//   CLAUSE 1 — THE RAW-VS-LIFTED MISMATCH. `agent/model.ts` handed the lock
//   `patience.firstChunkMs` — the RAW resolved value, 90s on an undeclared row — while the
//   transport eleven lines below armed `bounds.firstChunkMs`, the LIFTED value, which for that
//   same undeclared row is `TRANSPORT_DEFAULT_TIMEOUT_MS` (300s). So agent B, queued behind an
//   entirely healthy same-model call ENTITLED to 300 seconds of prefill, was rejected at 90 with
//   "timed out waiting behind a long prefill". A healthy turn killed by a gap between two
//   expressions. The census located the cause precisely and called the fix one word.
//
//   CLAUSE 2 — THE CROSS-MODEL ARM HAD NO PATIENCE INPUT AT ALL. The same-model queue has taken
//   the caller's declared bound since T81c; the model-swap queue one function below was a flat
//   `QUEUE_TIMEOUT_MS` (60s). Both are the same kind of wait — "another call has the GPU and I am
//   next" — so a provider declaring long patience was honoured on one path and ignored on the
//   other, and a healthy turn on a slow box was rejected at 60s for queueing behind a swap it was
//   entitled to wait out.
//
// Tested before this? `a-same-model-request-queues-behind-a-running-one.test.ts:170` pins the
// same-model fallback. The cross-model path and the raw-vs-lifted mismatch were both unpinned.
//
// Every duration below is a TEST FIXTURE, never a production constant, so a clause cannot be
// satisfied by accidentally matching a hardcoded number.
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const PROVIDER = 'prov-fixture-91';
const MODEL = 'fixture-model-gamma';
const OTHER_MODEL = 'fixture-model-delta';

beforeEach(() => {
  // `ollama-lock.ts` is a process-wide singleton and its slot/queue state IS the contention
  // under test, so the registry is reset per clause.
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

describe('clause 2 — the cross-model swap queue honours declared patience', () => {
  it('THE RED: a declared row queued behind a model SWAP does not starve at the flat 60s', async () => {
    // A declared patience far above the flat swap bound, as an arbitrary fixture.
    const declaredMs = 241_000;
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    // The provider's one slot (default max = 1) is busy with a DIFFERENT model, which is what
    // routes the next acquire into the cross-model queue rather than the same-model arm.
    await lock.acquire(PROVIDER, MODEL, declaredMs);

    let timedOut = false;
    let resolved = false;
    const waiter = lock.acquire(PROVIDER, OTHER_MODEL, declaredMs)
      .then(() => { resolved = true; })
      .catch(() => { timedOut = true; });

    // Past the old flat 60s bound, well inside the declared patience.
    await vi.advanceTimersByTimeAsync(95_000);
    expect(timedOut, 'a declared row must not be rejected at a bound it never declared').toBe(false);
    expect(resolved, 'and it is still waiting, not let through early').toBe(false);

    lock.release(PROVIDER, MODEL);
    await waiter;
    expect(resolved, 'the swap happens once the slot frees').toBe(true);
    lock.release(PROVIDER, OTHER_MODEL);
  });

  it('THE OTHER DIRECTION: the bound still fires — past the declared patience the waiter is rejected', async () => {
    const declaredMs = 120_000;
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    await lock.acquire(PROVIDER, MODEL, declaredMs);
    let timedOut = false;
    let message = '';
    const waiter = lock.acquire(PROVIDER, OTHER_MODEL, declaredMs)
      .catch((e: Error) => { timedOut = true; message = e.message; });

    await vi.advanceTimersByTimeAsync(declaredMs + 5_000);
    await waiter;

    expect(timedOut, 'an unbounded queue is not the fix — the wait still ends').toBe(true);
    expect(message, 'and the rejection names the bound that fired').toMatch(/timed out after \d+s/);
    lock.release(PROVIDER, MODEL);
  });

  it('CONTROL: an UNDECLARED row keeps today\'s flat 60s exactly — no behaviour invented for it', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    vi.useFakeTimers();

    // No declared patience passed at all: the resolver must fall back to QUEUE_TIMEOUT_MS.
    await lock.acquire(PROVIDER, MODEL);
    let timedOut = false;
    const waiter = lock.acquire(PROVIDER, OTHER_MODEL).catch(() => { timedOut = true; });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(timedOut, 'still inside the standing 60s').toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await waiter;
    expect(timedOut, 'and it expires at the standing 60s, unchanged').toBe(true);
    lock.release(PROVIDER, MODEL);
  });
});

describe('clause 1 — the transport hands the lock the number it will itself arm', () => {
  /**
   * A SOURCE-SHAPE clause, and it reads the source with comments STRIPPED — the prose around
   * this call site discusses `patience.firstChunkMs` at length, so a clause that merely grepped
   * the file would be satisfied by the commentary rather than by the call.
   */
  function ollamaTransportSource(): string {
    const raw = fs.readFileSync(path.join(SRC, 'agent/model.ts'), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  it('THE RED: `lock.acquire` is handed the LIFTED bound, not the raw resolved patience', () => {
    const src = ollamaTransportSource();

    expect(
      /lock\.acquire\(\s*modelInfo\.providerId,\s*ollamaModelName,\s*bounds\.firstChunkMs\s*\)/.test(src),
      'the lock must receive the same expression the watchdog arms',
    ).toBe(true);
    expect(
      /lock\.acquire\([^)]*patience\.firstChunkMs[^)]*\)/.test(src),
      'the raw resolved value must no longer reach the lock — that IS the defect',
    ).toBe(false);
  });

  it('and `bounds` is computed BEFORE the acquire, which is what makes that possible', () => {
    const src = ollamaTransportSource();
    const boundsAt = src.indexOf('const bounds: StreamPatience');
    const acquireAt = src.indexOf('lock.acquire(');

    expect(boundsAt, 'the bounds expression exists').toBeGreaterThan(-1);
    expect(acquireAt, 'the acquire exists').toBeGreaterThan(-1);
    expect(boundsAt, 'ordering is the mechanism: bounds must be in hand at acquire time')
      .toBeLessThan(acquireAt);
  });

  it('CONTROL: the watchdog still arms the same expression, so the two cannot drift again', () => {
    const src = ollamaTransportSource();

    // If a future edit re-points one of the two readers at a different expression, this pair
    // stops agreeing and the clause fails — which is the drift the defect was made of.
    expect(
      /makeStreamWatchdog\(\s*params\.abortSignal,\s*bounds\.firstChunkMs,\s*bounds\.idleMs\s*\)/.test(src),
      'the watchdog reads `bounds` too',
    ).toBe(true);
  });
});
