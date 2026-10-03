// ⚠ THE PROOF OBLIGATION. I stopped mid-package last round rather than ship a wired-but-unmeasured
// offload, because an offload nobody measures has only MOVED the pin somewhere nobody is watching. So
// these clauses are the deliverable, not the wiring:
//   1. the serving thread stays SERVICEABLE while a worker-side search runs (starved-ms, the same
//      instrument t87 built and deliverable 2 reused);
//   2. a stop mid-search DISCARDS the result and the pool survives;
//   3. an overrun past the hard deadline TERMINATES the worker;
//   4. the cross-check the coordinator asked for: a worker-side search must NOT trip the stall sentinel
//      I built in deliverable 4 — which is the same claim as (1), asserted by the other instrument.
//
// The fixture is generated and fictional. It is written to a real file because a worker opens its own
// connection: `:memory:` is per-connection by definition, and a test that used it would be proving
// nothing about a second thread.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-t89-offload-'));
const dbPath = path.join(dbDir, 'fixture.db');

// The pool asks `getDbPath()` where to read, so the fixture IS the database as far as it is concerned.
vi.mock('../../db/connection.js', () => ({
  getDbPath: () => dbPath,
  getDb: () => { throw new Error('the offload clauses never touch the serving-thread connection'); },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  readerQuery, readerPoolAvailable, readerPendingCount, terminateReaderPool,
  resetReaderPoolForTest, READER_DEADLINE_MS, warmReaderPool,
} from '../reader-pool.js';
import { evaluateTick, resetSentinelForTest, TICK_MS } from '../../observability/stall-sentinel.js';

/** t87's metric, reused: elapsed wall time minus the time the loop demonstrably serviced. */
async function measureStarvation(work: () => Promise<unknown>): Promise<{
  starvedMs: number; elapsedMs: number; ticks: number;
}> {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  try { await work(); } finally { clearInterval(timer); }
  const elapsedMs = Date.now() - t0;
  return { starvedMs: Math.max(0, elapsedMs - ticks * 10), elapsedMs, ticks };
}

/** A read heavy enough to pin a thread for a measurable while: the unbounded shape, deliberately. */
const HEAVY_SQL = `
  SELECT COUNT(*) AS n FROM messages a
  WHERE a.content LIKE '%nothing-matches-this%'
     OR a.content LIKE '%nor-this%'
     OR a.content LIKE '%nor-this-either%'
`;

const ROWS = 40_000;

beforeAll(() => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');          // the property that makes a second reader safe
  db.exec(`CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  const ins = db.prepare('INSERT INTO messages (agent_id, content, created_at) VALUES (?,?,?)');
  const filler = 'generated fixture text that is wide enough to cost real bytes to read '.repeat(8);
  db.transaction(() => {
    for (let i = 0; i < ROWS; i += 1) ins.run('agent-fixture', `${filler} row-${i}`, 1_700_000_000_000 + i);
  })();
  db.close();
});

afterAll(async () => {
  await terminateReaderPool();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetReaderPoolForTest();
  resetSentinelForTest();
});

describe('⚠ 1. THE SERVING THREAD STAYS SERVICEABLE — the claim the offload exists to make', () => {
  it('the same heavy read starves the loop on-thread and does NOT off-thread', async () => {
    expect(readerPoolAvailable(), 'worker threads are unavailable in this environment').toBe(true);
    // ⚠ WARM FIRST, AND THE REASON IS A MEASUREMENT: a COLD first query costs ~10ms of main-thread time
    // (compiling the inline source, opening the connection) against ~0 for every query after it. That is
    // a real one-time cost and it belongs at boot, not inside somebody's search — so the steady-state
    // claim is measured steady-state, and the cold cost gets its own clause below.
    await warmReaderPool();

    // ⚠ FIVE READS, NOT ONE, AND THE REASON IS THE INSTRUMENT'S OWN GRANULARITY. starved-ms counts
    // 10 ms per tick serviced, so over a ~50 ms window a single missed tick is ±10 ms of quantization
    // noise — enough to swamp the signal. My first version asserted an absolute starved-ms ceiling and
    // failed on exactly that noise (17 ms "starved" while the loop had serviced 3 of a possible 4
    // ticks, i.e. it was plainly alive). A longer window makes the fraction meaningful.
    const READS = 5;

    // ON-THREAD: the pre-fix shape, synchronous reads on the thread that would be serving HTTP.
    const onThreadDb = new Database(dbPath, { readonly: true });
    const onThread = await measureStarvation(async () => {
      for (let i = 0; i < READS; i += 1) onThreadDb.prepare(HEAVY_SQL).all();
    });
    onThreadDb.close();

    // OFF-THREAD: the same SQL, same file, same count, through the pool.
    const offThread = await measureStarvation(async () => {
      for (let i = 0; i < READS; i += 1) await readerQuery('offload-clause', HEAVY_SQL, []);
    });

    const serviced = (m: { ticks: number; elapsedMs: number }): number =>
      Math.min(1, (m.ticks * 10) / Math.max(1, m.elapsedMs));

    // eslint-disable-next-line no-console
    console.log(`OFFLOAD  on-thread starved ${onThread.starvedMs}ms of ${onThread.elapsedMs}ms `
      + `(${onThread.ticks} ticks, ${(serviced(onThread) * 100).toFixed(0)}% serviced) · off-thread starved `
      + `${offThread.starvedMs}ms of ${offThread.elapsedMs}ms (${offThread.ticks} ticks, `
      + `${(serviced(offThread) * 100).toFixed(0)}% serviced) · ${READS} reads over ${ROWS} fixture rows`);

    // The pre-fix shape must actually block, or this fixture proves nothing.
    expect(onThread.starvedMs, 'the fixture is too small to pin the loop — nothing to prove').toBeGreaterThan(0);
    // ⚠ THE HEADLINE, AS THE CLAIM ACTUALLY IS: on-thread the loop is not serviced; off-thread it is.
    // "Serviceable" is a fraction, not an absolute — which is also the only form of the claim that is
    // stable on a machine whose own scheduler can lose a tick.
    expect(serviced(onThread), 'the on-thread read did not pin the loop').toBeLessThan(0.2);
    expect(serviced(offThread), 'the off-thread read starved the loop anyway').toBeGreaterThan(0.5);
    expect(offThread.ticks).toBeGreaterThan(onThread.ticks * 3);
  }, 60_000);

  it('the COLD first query is the only one that costs the main thread anything, and it is bounded', async () => {
    // Stated rather than hidden: the spawn is synchronous work on the serving thread. It is paid once
    // per process (the pool is long-lived), it is milliseconds not seconds, and `warmReaderPool()` moves
    // it to boot. A clause so that if it ever grows into something a user would feel, this fails.
    const cold = await measureStarvation(async () => {
      await readerQuery('cold-start', 'SELECT 1 AS ok', []);
    });
    // eslint-disable-next-line no-console
    console.log(`COLD START  spawn + first query starved the loop ${cold.starvedMs}ms of ${cold.elapsedMs}ms`);
    expect(cold.starvedMs).toBeLessThan(250);
  }, 30_000);

  it('the read still returns the right answer — an offload that loses rows is not an offload', async () => {
    const rows = await readerQuery<{ n: number }>('count-clause',
      'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', ['agent-fixture']);
    expect(rows[0].n).toBe(ROWS);
  }, 30_000);
});

describe('⚠ 2. A STOP MID-SEARCH DISCARDS THE RESULT, AND THE POOL SURVIVES', () => {
  it('an abort rejects the caller, drops the pending entry, and leaves the pool usable', async () => {
    const ac = new AbortController();
    const inFlight = readerQuery('abort-clause', HEAVY_SQL, [], { signal: ac.signal });
    expect(readerPendingCount()).toBe(1);

    ac.abort();
    await expect(inFlight).rejects.toThrow(/abort/i);
    // ⚠ DISCARDED: nobody is waiting, so the worker's eventual reply lands on nothing. This is what
    // makes a stop REAL — on the serving thread the abort signal could not even be received, because
    // the loop was inside the scan.
    expect(readerPendingCount()).toBe(0);

    // …and the very next query works, on the same worker, which is the "survives" half.
    const rows = await readerQuery<{ n: number }>('after-abort',
      'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', ['agent-fixture']);
    expect(rows[0].n).toBe(ROWS);
  }, 60_000);

  it('an already-aborted signal never dispatches at all', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(readerQuery('pre-aborted', 'SELECT 1', [], { signal: ac.signal }))
      .rejects.toThrow(/aborted before dispatch/);
    expect(readerPendingCount()).toBe(0);
  });
});

describe('⚠ 3. AN OVERRUN TERMINATES THE WORKER — the only way to stop synchronous C++', () => {
  it('a deadline past its budget kills the thread and the next query gets a fresh one', async () => {
    // A 1 ms deadline against a read that cannot finish that fast: the deadline fires while the worker
    // is inside `sqlite3_step`, where nothing in JavaScript can ask it to stop.
    await expect(readerQuery('overrun-clause', HEAVY_SQL, [], { deadlineMs: 1 }))
      .rejects.toThrow(/exceeded 1ms and the worker was terminated/);
    expect(readerPendingCount()).toBe(0);

    // The pool respawns on demand — it holds no state worth preserving, which is what makes terminate
    // an acceptable answer rather than a last resort.
    const rows = await readerQuery<{ n: number }>('after-terminate',
      'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', ['agent-fixture']);
    expect(rows[0].n).toBe(ROWS);
  }, 60_000);

  it('the default deadline is far above a bounded search and far below the measured freeze', () => {
    expect(READER_DEADLINE_MS).toBeGreaterThan(5_000);
    expect(READER_DEADLINE_MS).toBeLessThan(43_000);
  });
});

describe('⚠ THE WIRE, AS FAR AS IT GOES — and it says plainly how far that is', () => {
  it('the pool is WARMED at boot, so no user\'s first search pays the spawn', async () => {
    const boot = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8');
    expect(boot).toContain("from './memory/reader-pool.js'");
    expect(boot).toContain('warmReaderPool()');
  });

  it('⚠ AND THE RETRIEVAL PATHS DO NOT USE IT YET — pinned so the gap cannot be mistaken for done', () => {
    // Honest state, asserted rather than described in a report nobody re-reads: the pool is built and
    // MEASURED, and `memory/retrieval.ts` still runs its searches on the serving thread (bounded, as of
    // deliverable 2). Wiring it means making `memoryGrep` async and awaiting it at three call sites.
    // ⚠ WHEN THAT LANDS, THIS CLAUSE FAILS — which is the point: it is a tripwire on a known gap, and
    // whoever closes it must come here, flip this to `toContain`, and delete this comment.
    const retrieval = fs.readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8');
    expect(retrieval).not.toContain('readerQuery');
  });
});

describe('⚠ 4. THE CROSS-CHECK: a worker-side search does NOT trip the stall sentinel', () => {
  it('the sentinel sees no stall across an off-thread read it would have flagged on-thread', async () => {
    // Two instruments, one claim. The sentinel is what would have named this query in the log as the
    // thing that deafened the box; after the offload it has nothing to report, which is the proof that
    // the pin is gone rather than merely renamed.
    let worstDrift = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      worstDrift = Math.max(worstDrift, now - last - TICK_MS);
      last = now;
    }, TICK_MS);
    try {
      await readerQuery('sentinel-cross-check', HEAVY_SQL, []);
    } finally {
      clearInterval(ticker);
    }
    // The sentinel's own arithmetic, fed the worst drift observed during the read.
    const report = evaluateTick(TICK_MS + worstDrift, 0);
    // eslint-disable-next-line no-console
    console.log(`SENTINEL CROSS-CHECK  worst drift during the off-thread read: ${worstDrift}ms `
      + `(threshold 1000ms) → ${report ? 'STALL REPORTED' : 'no stall'}`);
    expect(report, 'an off-thread read tripped the stall sentinel — the offload is not working').toBeNull();
  }, 60_000);
});
