// ⚠ THE INSTRUMENT, AND THEN THE WIRE. The campaign rule is that every policy clause needs a wire
// clause and that wire clauses COUNT in both directions — so the second half of this file counts
// breadcrumb marks against breadcrumb clears across the retrieval module, which is how a fourth search
// path added tomorrow is caught without anybody remembering to come back here.
//
// WHAT THE INSTRUMENT IS FOR, in the numbers from the box that asked for it: 40-50 seconds of pinned
// CPU out of every 60, the server deaf to a health probe at a 5-second timeout for 43 seconds at a
// stretch, and the log still unable to say what was running — because the timer line that eventually
// printed landed ~20 seconds INTO the window. A profiler sample missed the window by seconds. Drift is
// the only thing a pinned process can measure about itself.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  diagnose, evaluateTick, breadcrumbFor, markQueryDispatched, clearQueryDispatched,
  currentBreadcrumb, resetSentinelForTest, TICK_MS, STALL_THRESHOLD_MS,
} from '../stall-sentinel.js';

beforeEach(() => { resetSentinelForTest(); });

describe('the sentinel measures drift and says one useful thing about it', () => {
  it('an ordinary tick is silence — the instrument must cost nothing to leave on', () => {
    const now = 1_000_000;
    expect(evaluateTick(now, now - TICK_MS)).toBeNull();
    // Even a sloppy tick (GC, a busy loop) is silence: under a second is noise nobody can act on.
    expect(evaluateTick(now, now - TICK_MS - 400)).toBeNull();
  });

  it('a stall past the threshold reports once, and ONLY once per window', () => {
    // ⚠ A 43-SECOND STALL MUST PRODUCE ONE LINE, NOT 172. The sentinel ticks four times a second; a
    // warn per tick would bury the one fact a reader needs under its own noise.
    const now = 2_000_000;
    const first = evaluateTick(now, now - TICK_MS - 5_000);
    expect(first).not.toBeNull();
    expect(first?.stalledMs).toBe(5_000);
    expect(evaluateTick(now + TICK_MS, now), 'a second report inside the same window').toBeNull();
    // …and after the loop recovers, the next stall is reportable again.
    expect(evaluateTick(now + 2 * TICK_MS, now + TICK_MS)).toBeNull();     // a healthy tick re-arms
    expect(evaluateTick(now + 60_000, now + 2 * TICK_MS)).not.toBeNull();
  });

  it('the threshold is the brief\'s line, and the tick is fine enough to measure it', () => {
    expect(STALL_THRESHOLD_MS).toBe(1_000);
    expect(TICK_MS).toBeLessThan(STALL_THRESHOLD_MS / 2);
  });
});

describe('⚠ THE DIAGNOSIS NAMES THE SUSPECT — three cases, three different next steps', () => {
  it('a breadcrumb that outlived the stall IS the blocker, by name', () => {
    const crumb = { label: breadcrumbFor('history_search', 'fts'), startedAtMs: 1_000 };
    const r = diagnose(43_000, crumb, 1_000 + 50_000);
    expect(r.diagnosis).toContain('history_search:fts');
    expect(r.diagnosis).toContain('that query is the blocker');
    expect(r.breadcrumbAgeMs).toBe(50_000);
  });

  it('a breadcrumb YOUNGER than the stall is a lead, and the line says so', () => {
    // The user's own log had a timer line landing ~20s into the window — work that started after the
    // pin began. Calling that the cause would send the next reader to the wrong query.
    const crumb = { label: breadcrumbFor('vault_search', 'like'), startedAtMs: 10_000 };
    const r = diagnose(43_000, crumb, 12_000);
    expect(r.diagnosis).toContain('vault_search:like');
    expect(r.diagnosis).toContain('a lead and not the whole cause');
  });

  it('⚠ NO BREADCRUMB IS A FINDING, NOT AN "UNKNOWN"', () => {
    // The capture that motivated this file had free memory collapsed to ~60 MB in the same window, so
    // a sentinel that only ever blamed queries would have been confidently wrong. The absence of
    // instrumented work points somewhere specific and the sentence has to say where.
    const r = diagnose(38_000, null, 500_000);
    expect(r.breadcrumb).toBeNull();
    expect(r.diagnosis).toContain('NO instrumented query in flight');
    expect(r.diagnosis).toMatch(/paging|checkpoint|uninstrumented/);
  });

  it('the stall and the suspect both appear in the one line, with numbers', () => {
    const r = diagnose(43_000, { label: 'history_search:like', startedAtMs: 0 }, 43_500);
    expect(r.diagnosis).toContain('43000ms');
    expect(r.diagnosis).toContain('history_search:like');
  });
});

describe('the breadcrumb is a shape, and nesting cannot erase the slow one', () => {
  it('⚠ NEVER A USER\'S QUERY TEXT — this string reaches pasted logs', () => {
    const label = breadcrumbFor('history_search', 'fts');
    expect(label).toBe('history_search:fts');
    // The constraint is in the brief: no user query text in any shipped surface. The breadcrumb is the
    // easiest place in this package to violate it by accident, so the builder is the SUBSYSTEM and the
    // MODE and takes no pattern argument at all — there is nowhere to put one.
    expect(breadcrumbFor.length).toBe(2);
  });

  it('a fast inner mark cannot clear the slow outer one', () => {
    // ⚠ THIS IS THE CASE THE INSTRUMENT EXISTS FOR: a cheap query completing inside a pinned one must
    // not wipe the mark of the query that is actually blocking the loop, or the stall reports "no
    // instrumented work" and the real culprit is never named.
    const outer = markQueryDispatched('history_search:fts');
    const inner = markQueryDispatched('summary_search:fts');
    // ⚠ MY FIRST VERSION HELD ONE SLOT AND THIS CLAUSE FAILED: the inner clear wiped the mark, so the
    // sentinel would have reported "no instrumented query in flight" with a 43-second scan still
    // running — a confident wrong answer pointing at paging. It is a stack now, and the OLDEST mark is
    // what gets blamed, because the enclosing query has been blocking longest.
    clearQueryDispatched(inner);
    expect(currentBreadcrumb()?.label).toBe('history_search:fts');
    clearQueryDispatched(outer);
    expect(currentBreadcrumb()).toBeNull();
  });

  it('a cleared mark leaves nothing behind, so an idle loop stall reports as idle', () => {
    const crumb = markQueryDispatched('vault_search:like');
    clearQueryDispatched(crumb);
    expect(currentBreadcrumb()).toBeNull();
  });
});

describe('⚠ THE WIRE — and it COUNTS, in both directions', () => {
  const retrieval = readFileSync(new URL('../../memory/retrieval.ts', import.meta.url), 'utf-8');

  it('every retrieval search path marks a breadcrumb, and every mark is cleared', () => {
    const marks = retrieval.match(/markQueryDispatched\(/g)?.length ?? 0;
    const clears = retrieval.match(/clearQueryDispatched\(/g)?.length ?? 0;
    // ⚠ BOTH DIRECTIONS. Too few marks and a search path is invisible to the sentinel — the freeze goes
    // back to being unnamed. Too few clears and a finished query keeps blaming itself for the next
    // stall, which is worse than silence because it is confidently wrong.
    expect(marks, 'a retrieval search path with no breadcrumb is invisible to the sentinel').toBeGreaterThanOrEqual(2);
    expect(clears, 'every mark must be cleared in a finally').toBe(marks);
    // Each one in a `finally`, so a throwing query cannot leave its mark live forever.
    expect(retrieval.match(/finally \{\s*clearQueryDispatched/g)?.length ?? 0).toBe(marks);
  });

  it('the sentinel is STARTED at boot — an instrument nobody runs measures nothing', () => {
    const boot = readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8');
    expect(boot).toContain("from './observability/stall-sentinel.js'");
    expect(boot).toContain('startStallSentinel()');
  });
});
