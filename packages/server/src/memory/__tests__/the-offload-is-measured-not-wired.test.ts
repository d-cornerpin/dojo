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

const dbDir = fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t89-offload-'));
const dbPath = path.join(dbDir, 'fixture.db');

// The pool asks `getDbPath()` where to read, so the fixture IS the database as far as it is concerned.
// ⚠ OVERRIDABLE (I3): one clause needs the pool pointed at a path the worker CANNOT open, which is
// the asynchronous failure mode the old code could not see — the spawn succeeds and the open does not.
let dbPathOverride: string | null = null;
vi.mock('../../db/connection.js', () => ({
  getDbPath: () => dbPathOverride ?? dbPath,
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

  it('the retrieval paths USE the pool — EVERY search path, counted in both directions', () => {
    // The former tripwire, flipped the day the wire landed (its design): retrieval routes through
    // readerQuery when the pool is up, and the sync run is the FALLBACK.
    //
    // ⚠ COUNTED EXACTLY, NOT `toBeGreaterThanOrEqual` — the campaign rule this package is held to is
    // that a wire clause must count in BOTH directions. A `>=` clause stays green when a FIFTH search
    // path is added without the fork, which is precisely how a policy helper ends up fully covered
    // while the line joining it to a caller is not. Adding a path reds this; deleting a wire reds it
    // too; and the reader has to come here and say which it was.
    // ⚠ COMMENTS STRIPPED BEFORE COUNTING (G4), and a round-1 finding forced it: `readerPoolAvailable()`
    // is now NAMED in two comments explaining the I4 breadcrumb, so a raw count read 9 where the code
    // has 7. A counting clause that counts prose is a clause that can be satisfied by writing about
    // the wire instead of wiring it.
    const retrieval = fs.readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // THREE SEARCHABLE SURFACES (messages, summaries, history_expand) × two MODES (fts, bounded
    // LIKE) = six paths. The third arrived with t89 item 1 and these numbers moved WITH it, by hand,
    // in the same commit — which is the whole value of counting exactly.
    // ⚠ `crumbFor`, not `breadcrumbFor`: the mark now carries WHERE the work runs (I4), so the one
    // call to `breadcrumbFor` lives inside that helper and the per-surface sites name this one.
    const breadcrumbs = new Set((retrieval.match(/crumbFor\('([a-z_]+)'/g) ?? []));
    expect(breadcrumbs.size, 'one breadcrumb per searchable surface').toBe(3);

    // One fork per path (6), plus ONE in `crumbFor` that decides the breadcrumb's suffix — which is
    // counted deliberately rather than excused, because a seventh fork appearing anywhere else is
    // exactly what this clause is for.
    const guarded = (retrieval.match(/readerPoolAvailable\(\)/g) ?? []).length;
    expect(guarded, 'a fork per search path, plus the breadcrumb\'s — add a path, wire it or red this')
      .toBe(7);

    // The LIKE paths cost two worker reads each (the honest cost, then the page); the FTS paths one.
    const wired = (retrieval.match(/readerQuery[<(]/g) ?? []).length;
    expect(wired, '3 fts + 3×(cost+page)').toBe(9);

    // ⚠ AND EVERY WIRED READ IS LABELLED DISTINCTLY, because the pool attributes results by id and a
    // duplicated label is the mis-attribution this file's concurrency clause exists to catch.
    const labels = (retrieval.match(/readerQuery<[A-Za-z]+>\('([a-z_:]+)'/g) ?? [])
      .map((m) => m.slice(m.indexOf("('") + 2, -1));
    expect(labels.length, 'every wired read carries a label').toBe(wired);
    expect(new Set(labels).size, 'and no two share one').toBe(wired);
    for (const surface of ['history_search', 'summary_search', 'history_expand']) {
      expect(labels, `${surface} wires its FTS read`).toContain(`${surface}:fts`);
      expect(labels, `${surface} wires its LIKE cost read`).toContain(`${surface}:like:cost`);
      expect(labels, `${surface} wires its LIKE page read`).toContain(`${surface}:like:page`);
    }
  });

  it('the summaries path is BOUNDED, not merely offloaded — the two are different fixes', () => {
    // t89 item 2. Offloading an unbounded walk moves the freeze to a worker; the bound is what makes
    // it finite. Both halves are asserted on the source because the arithmetic lives in
    // `search-bounds.ts` and the caller owns only the SQL — so what is checkable here is that the
    // caller ASKED for the bound on both of its modes.
    const retrieval = fs.readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8');
    // ⚠ READ WITH THE COMMENTS STRIPPED, and that is not fastidiousness — my first cut of this clause
    // asserted `toContain('ftsCandidateRowidFloor')` over the raw source and a mutant that DELETED
    // THE CALL still passed, because the paragraph above the call names the function. A clause that
    // matches its own comment tests the comment. Strip, then assert on the CALL.
    const code = retrieval.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const summaries = code.slice(code.indexOf('async function searchSummariesInner'));
    // ⚠ ROUND 2 MOVED THE FLOOR'S DERIVATION, so this half moved with it. It is no longer
    // `ftsCandidateRowidFloor(maxRid)` at the query: the summaries arms take `summariesFtsWindow`,
    // which keeps the global floor while the agent HAS rows inside it and RE-SEATS it on the agent
    // when it does not — because the global-only floor excluded every agent whose summaries all sit
    // below the window (finding A: 50 matching rows returned as 0). The assertion's two halves are
    // unchanged in spirit: a floor is derived HERE, and it is APPLIED to the query.
    expect(summaries, 'the FTS candidate set is no longer floored to a recency window')
      .toMatch(/candidateFloor\s*=\s*window\.candidateFloor/);
    expect(summaries, 'and the floor is actually APPLIED to the query, not merely computed')
      .toMatch(/s\.rowid\s*>\s*\?/);
    expect(summaries, 'the LIKE walk runs in budgeted chunks').toMatch(/boundedRecencyScan(Sync)?</);
    expect(summaries, 'and a truncated or multi-chunk walk says so out loud')
      .toContain("logBoundedFallback('summary_search:like'");
    // The scans are keyed on the ALIASED rowid, never a bare one — T10's reader guard, and the shape
    // that reads `undefined` without throwing if it comes back.
    expect(summaries).toContain('rowid AS rid');
    // ⚠ PROJECTIONS ONLY. A bare `rowid` in a WHERE or ORDER BY is correct and necessary — the chunk
    // ceiling and the cost count both need it. It is projecting one unaliased that reads `undefined`
    // without throwing, so this reads the SELECT…FROM span and nothing else. (My first cut asserted
    // over the whole function and caught the cost query's legitimate `WHERE rowid <= ?`.)
    const projections = [...summaries.matchAll(/SELECT\s([\s\S]*?)\sFROM\s+summaries/g)].map((m) => m[1]);
    expect(projections.length, 'both the page and the cost query are read').toBeGreaterThanOrEqual(2);
    for (const proj of projections) {
      // The dangerous shape is a BARE STANDALONE projection item — `SELECT id, rowid FROM …` — which
      // SQLite may name something else and which then reads `undefined`. `MAX(rowid) AS r` and
      // `rowid AS rid` are both aliased at the expression level and are the correct forms.
      expect(/(^|,)\s*rowid\s*(,|$)/.test(proj), `bare rowid projected in: ${proj.trim()}`).toBe(false);
    }
  });

  it('history_expand is BOUNDED too — the last unbounded text search on this surface', () => {
    // ⚠ t89 item 1, AND A CORRECTION TO ITS OWN BRIEF, recorded here because the next reader will
    // otherwise go looking in the wrong file. The brief called this pair "the vault search" and
    // located it at `retrieval.ts:447` / `:471+`. Those line numbers are `history_expand`'s summary
    // lookup, in THIS file. The real `vault_search` is `vault/store.ts`'s `semanticSearch` /
    // `listEntries({ search })` — a different unbounded shape, in a file this change does not own,
    // handed up rather than guessed at.
    //
    // READ WITH COMMENTS STRIPPED, and the lesson is the summaries half's own: its first bound
    // clause asserted `toContain('ftsCandidateRowidFloor')` over the RAW source and the mutant that
    // DELETED THE CALL still passed, because the paragraph above the call names the function. So:
    // strip, assert the CALL SHAPE, and separately assert the bound is APPLIED rather than computed.
    const retrieval = fs.readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8');
    const code = retrieval.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fts = code.slice(code.indexOf('async function expandSummariesFts'),
      code.indexOf('async function expandSummariesLike'));
    const like = code.slice(code.indexOf('async function expandSummariesLike'),
      code.indexOf('export async function memoryExpand'));
    expect(fts.length, 'the FTS helper was not found by name').toBeGreaterThan(0);
    expect(like.length, 'the LIKE helper was not found by name').toBeGreaterThan(0);

    // ⚠ ROUND 2 MOVED THE FLOOR'S DERIVATION, so this half moved with it. It is no longer
    // `ftsCandidateRowidFloor(maxRid)` at the query: the summaries arms take `summariesFtsWindow`,
    // which keeps the global floor while the agent HAS rows inside it and RE-SEATS it on the agent
    // when it does not — because the global-only floor excluded every agent whose summaries all sit
    // below the window (finding A: 50 matching rows returned as 0). The assertion's two halves are
    // unchanged in spirit: a floor is derived HERE, and it is APPLIED to the query.
    expect(fts, 'the FTS candidate set is no longer floored to a recency window')
      .toMatch(/candidateFloor\s*=\s*window\.candidateFloor/);
    expect(fts, 'and the floor is actually APPLIED to the query, not merely computed')
      .toMatch(/s\.rowid\s*>\s*\?/);
    expect(like, 'the LIKE walk runs in budgeted chunks').toMatch(/boundedRecencyScan(Sync)?</);
    expect(like, 'and a truncated or multi-chunk walk says so out loud')
      .toContain("logBoundedFallback('history_expand:like'");
    // The bounded walk chunks on the ALIASED rowid — T10's reader guard. Projections only: a bare
    // `rowid` in a WHERE or ORDER BY is correct and necessary here (the ceiling and the cost count
    // both need it); it is projecting one unaliased that reads `undefined` without throwing.
    expect(like).toContain('rowid AS rid');
    const projections = [...like.matchAll(/SELECT\s([\s\S]*?)\sFROM\s+summaries/g)].map((m) => m[1]);
    expect(projections.length, 'both the page and the cost query are read').toBeGreaterThanOrEqual(2);
    for (const proj of projections) {
      expect(/(^|,)\s*rowid\s*(,|$)/.test(proj), `bare rowid projected in: ${proj.trim()}`).toBe(false);
    }
    // ⚠ AND THE PRE-FIX SHAPE IS GONE, not merely joined by a bounded sibling. A fix that adds a
    // bounded path beside the unbounded one has changed nothing — this is the half of the wire rule
    // that counts in the other direction.
    expect(code, 'the unbounded earliest_at walk still exists somewhere in this file')
      .not.toMatch(/ORDER BY earliest_at DESC/);
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

// ════════════════════════════════════════════════════════════════════════════════════════
// ⚠ FIX ROUND 1 — THE POOL'S FALLBACK HAS TO ENGAGE, AND A KILL HAS TO TAKE ONLY ITS OWN WORK.
//
// I3: the sync fallback engaged only on a SYNCHRONOUS spawn failure. Every other failure mode —
// the database cannot be opened read-only, the native module cannot be resolved, the thread cannot
// start — logged "searches stay on the serving thread" and then left `readerPoolAvailable()`
// answering TRUE, so every `readerQuery` rejected, the FTS arm's catch fell to the LIKE arm which
// rejected too, and `history_search` ERRORED while the sync path that works sat unused.
//
// I7: a deadline kill nulled `worker` before `terminate()`, so the exit handler's `worker === w`
// guard skipped the dying worker's OTHER in-flight queries. Each waited out its own full 15 seconds
// and then logged "terminating the reader worker" at a thread that was already dead. That guard was
// itself the fix for a real bug (a terminate rejecting the REPLACEMENT's innocent callers), so both
// directions have to hold at once — which is what these clauses assert.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('⚠ I3 — A FALLBACK THAT IS LOGGED MUST BE A FALLBACK THAT IS ENGAGED', () => {
  it('a database the worker cannot open LATCHES the pool shut, so callers go back on-thread', async () => {
    resetReaderPoolForTest();
    const gone = path.join(dbDir, 'no-such-database.db');
    fs.rmSync(gone, { force: true });
    dbPathOverride = gone;
    try {
      // The spawn itself SUCCEEDS — this is the asynchronous failure the old code could not see.
      expect(readerPoolAvailable(), 'the worker should spawn; it is the OPEN that fails').toBe(true);
      await expect(readerQuery('open-fail-clause', 'SELECT 1 AS ok', [])).rejects.toThrow();
      // ⚠ THE CLAIM: not "the query failed" but "the pool stepped aside". A caller asking again now
      // gets FALSE and runs its own query, which is what the warn says happens.
      await vi.waitFor(() => {
        expect(readerPoolAvailable(), 'the pool still claims to be available after an open failure')
          .toBe(false);
      }, { timeout: 5_000 });
      // And it STAYS shut — a respawn would re-run the same failure once per search.
      expect(readerPoolAvailable()).toBe(false);
      expect(readerPendingCount(), 'an in-flight query was left hanging').toBe(0);
    } finally {
      dbPathOverride = null;
      resetReaderPoolForTest();
    }
  }, 30_000);

  it('the worker is told WHERE better-sqlite3 is, so its require does not depend on cwd', () => {
    // An eval worker has no file of its own, so a bare `require('better-sqlite3')` resolves from
    // `process.cwd()`. Production's cwd makes that work today, which is luck, not design.
    const src = fs.readFileSync(new URL('../reader-pool.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, 'the worker still resolves the native module from cwd')
      .not.toMatch(/require\('better-sqlite3'\)/);
    expect(src, 'the path must be resolved on the main thread, where it is knowable')
      .toMatch(/createRequire\(import\.meta\.url\)\.resolve\('better-sqlite3'\)/);
    expect(src, 'and handed to the worker').toMatch(/betterSqlitePath/);
  });
});

describe('⚠ I7 — A DEADLINE KILL TAKES ITS OWN WORKER\'S QUERIES, AND ONLY THOSE', () => {
  it('a sibling of an overrun query rejects PROMPTLY, not after its own deadline', async () => {
    resetReaderPoolForTest();
    await warmReaderPool();
    // Two heavy reads in flight on the same worker. The first carries a 1 ms deadline, so it kills
    // the thread while both are queued; the second has the full default deadline.
    const victim = readerQuery('i7-overrun', HEAVY_SQL, [], { deadlineMs: 1 });
    const sibling = readerQuery('i7-sibling', HEAVY_SQL, []);
    const t0 = Date.now();
    await expect(victim).rejects.toThrow(/exceeded 1ms/);
    await expect(sibling).rejects.toThrow(/terminated/i);
    const waited = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`I7  the sibling of a deadline-killed query rejected after ${waited}ms `
      + `(its own deadline is ${READER_DEADLINE_MS}ms)`);
    // ⚠ A FRACTION OF ITS OWN DEADLINE, not a millisecond ceiling — seven lanes share this machine
    // and the claim is "it did not wait out its deadline", which a tenth of it states safely.
    expect(waited, 'the sibling waited out its own deadline against a dead worker')
      .toBeLessThan(READER_DEADLINE_MS / 10);
    expect(readerPendingCount(), 'the dead worker left entries behind').toBe(0);
  }, 60_000);

  it('…and the REPLACEMENT worker\'s callers are NOT collateral — the other direction', async () => {
    // The guard this fix had to keep. `terminate()` resolves BEFORE the thread's `exit` event, so by
    // the time that event lands the pool has spawned a replacement and the next caller is already
    // queued against it. A blanket "fail everything on exit" rejected that innocent caller with
    // "reader worker exited" — the defect the first round recorded. Scoping by worker keeps both.
    resetReaderPoolForTest();
    await warmReaderPool();
    await expect(readerQuery('i7-kill', HEAVY_SQL, [], { deadlineMs: 1 })).rejects.toThrow(/exceeded/);
    const after = await readerQuery<{ n: number }>('i7-after-kill',
      'SELECT COUNT(*) AS n FROM messages WHERE agent_id = ?', ['agent-fixture']);
    expect(after[0].n, 'the query that followed the kill was failed by the dead worker\'s exit')
      .toBe(ROWS);
  }, 60_000);
});

describe('⚠ I4 — A STALL DURING AN OFF-THREAD SEARCH IS NOT THAT SEARCH\'S FAULT', () => {
  it('an @reader crumb is reported as CONTEXT, and the line never says "blocker"', async () => {
    // ⚠ THE DEFECT: before the wire, a live breadcrumb during a stall meant the thread was inside
    // that query. After it, the same crumb can be live while the query runs on a WORKER and the main
    // thread is blocked by something else — paging, a WAL checkpoint, an uninstrumented sync path.
    // The old line said "that query is the blocker" and sent the reader to the one thing that
    // provably was NOT on the thread, in the exact scenario this instrument was built for. That is
    // the "confident wrong answer" the module's own header warns against.
    const { diagnose, markQueryDispatched, clearQueryDispatched, currentBreadcrumb, offThreadBreadcrumb,
      isOffThread, resetSentinelForTest: reset } = await import('../../observability/stall-sentinel.js');
    reset();
    const label = offThreadBreadcrumb('history_search:fts');
    expect(isOffThread(label)).toBe(true);
    const crumb = markQueryDispatched(label);
    try {
      // Running the WHOLE stall — the shape that used to earn "that query is the blocker".
      const report = diagnose(43_210, currentBreadcrumb(), crumb.startedAtMs + 44_000);
      // eslint-disable-next-line no-console
      console.log(`I4  ${report.diagnosis}`);
      // ⚠ THE AFFIRMATIVE VERDICT MUST BE ABSENT AND THE NEGATION PRESENT — asserted as two separate
      // things, because my first cut said `not.toContain('blocker')` and red on the line's own
      // "CANNOT be the blocker". A clause that forbids a WORD instead of a CLAIM forbids the fix
      // from explaining itself.
      expect(report.diagnosis, 'an off-thread query was named as the cause')
        .not.toMatch(/that query is the blocker/);
      expect(report.diagnosis, 'the line must say OUT LOUD that it cannot be the cause')
        .toMatch(/CANNOT be the blocker/);
      expect(report.diagnosis, 'the line must say the work was off-thread').toContain('reader worker');
      expect(report.diagnosis, 'and must point where the cause actually could be')
        .toContain('uninstrumented');
      // The crumb is still REPORTED — it is context, not noise. Dropping it would lose the one fact
      // that tells the next reader a search was in flight at all.
      expect(report.breadcrumb?.label).toBe(label);
    } finally {
      clearQueryDispatched(crumb);
    }
  });

  it('an ON-thread crumb still earns the verdict — the other direction, or I4 is a silencer', async () => {
    const { diagnose, markQueryDispatched, clearQueryDispatched, currentBreadcrumb,
      resetSentinelForTest: reset } = await import('../../observability/stall-sentinel.js');
    reset();
    const crumb = markQueryDispatched('history_search:like');
    try {
      const report = diagnose(43_210, currentBreadcrumb(), crumb.startedAtMs + 44_000);
      expect(report.diagnosis, 'an on-thread query that spanned the stall IS the blocker')
        .toContain('that query is the blocker');
      expect(report.diagnosis).not.toContain('reader worker');
    } finally {
      clearQueryDispatched(crumb);
    }
  });

  it('the retrieval marks carry the suffix when the pool has the work, and not when it does not', () => {
    const src = fs.readFileSync(new URL('../retrieval.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // The decision is read ONCE, in one helper, and APPLIED to the mark — a mark that disagreed with
    // the read beneath it would be the same defect in a smaller box.
    expect(src).toMatch(/function crumbFor\(subsystem: string, mode: string\): string \{/);
    expect(src, 'the suffix is not applied to the mark')
      .toMatch(/readerPoolAvailable\(\) \? offThreadBreadcrumb\(label\) : label/);
    // And every surface goes through it — no site may mark a raw label and bypass the decision.
    expect(src, 'a search path marks a breadcrumb without saying where the work runs')
      .not.toMatch(/markQueryDispatched\(breadcrumbFor\(/);
  });
});
