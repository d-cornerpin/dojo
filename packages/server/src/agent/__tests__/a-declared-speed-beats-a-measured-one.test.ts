// ════════════════════════════════════════════════════════════════════════════════════════
// PREFILL SELF-CALIBRATION — THE PRECEDENCE, AND THE GAP IT FILLS.
//
// OWNER DESIGN RULING, 2026-09-22: "never ask the user for a number the platform can observe."
// Migration 167 gives every provider a MEASURED prefill rate off its own cost ledger. This file
// pins the two facts the rest of the engine depends on that measurement having:
//
//  1. DECLARED ALWAYS WINS. When `prefill_tokens_per_sec` holds a coherent number, the measured
//     column is not read at all — not preferred, not averaged, not consulted. An override a
//     machine can silently overrule is not an override. The inversion is planted below: swap
//     the two and this file goes red on the exact clause that names the owner's number.
//  2. WHEN NOBODY DECLARED, THE LEDGER ANSWERS. This is the whole point: before this ruling the
//     doom ceiling was `null` for every undeclared provider, which turned the pre-dial gate,
//     the admission budget, the compaction trigger and the router's fit filter all OFF for
//     exactly the slow local boxes they were built for.
//  3. AND WHEN NEITHER EXISTS, NOTHING CHANGED. Both columns NULL resolves to `null`, which is
//     the byte-preservation control migrations 166 and 167 both promise in their own headers.
//
// The arithmetic of the estimator itself is not here — it is in
// `costs/__tests__/the-ledger-measures-the-box.test.ts`, with the round-5 fixture.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  resolvePrefillThroughput,
  resolveDoomCeiling,
  providerAwareBudgetTokens,
  PROVIDER_CEILING_SAFETY,
  TRANSPORT_MARGIN_MS,
  PREFILL_THROUGHPUT_MIN_TOK_PER_SEC,
  PREFILL_THROUGHPUT_MAX_TOK_PER_SEC,
} from '../stream-patience.js';

// TEST VALUES, never code constants. The owner's hand-measured claim about his own box (~200)
// beside what the ledger actually observed on it (181.07…): the real pair, which is also the
// pair that makes the precedence question non-trivial, because they DISAGREE.
const OWNER_DECLARED = 200;
const LEDGER_MEASURED = 181.07;
const DECLARED_PATIENCE_MS = 600_000;

describe('resolvePrefillThroughput — declared wins, and says so', () => {
  it('returns the DECLARED number when both exist, and names its source', () => {
    const r = resolvePrefillThroughput(OWNER_DECLARED, LEDGER_MEASURED);
    expect(r).toEqual({ tokensPerSec: OWNER_DECLARED, source: 'declared' });
    // The clause that catches an inversion: the measured number must not appear anywhere in
    // the answer, not even rounded into it.
    expect(r?.tokensPerSec).not.toBe(Math.floor(LEDGER_MEASURED));
  });

  it('returns the MEASURED number, floored, when nobody declared one', () => {
    expect(resolvePrefillThroughput(null, LEDGER_MEASURED)).toEqual({ tokensPerSec: 181, source: 'measured' });
    expect(resolvePrefillThroughput(undefined, LEDGER_MEASURED)).toEqual({ tokensPerSec: 181, source: 'measured' });
  });

  it('FLOORS rather than rounds — every approximation in this feature points the same way', () => {
    // 181.9 rounds to 182, which would be the one step in the chain claiming the box is faster
    // than anything ever observed on it. The whole estimator is a max of LOWER bounds; the
    // floor is what keeps the reader on that side of the truth.
    expect(resolvePrefillThroughput(null, 181.9)?.tokensPerSec).toBe(181);
    expect(resolvePrefillThroughput(null, 4999.99)?.tokensPerSec).toBe(4999);
  });

  it('returns null when neither exists — the byte-preservation control', () => {
    expect(resolvePrefillThroughput(null, null)).toBeNull();
    expect(resolvePrefillThroughput(undefined, undefined)).toBeNull();
    expect(resolvePrefillThroughput(null)).toBeNull();
  });

  it('an INCOHERENT declaration is not a declaration, and the measurement steps in', () => {
    // Same asymmetry `isCoherent` documents for the patience bounds: the write door refuses
    // these, but a hand-edited row or a restored backup can still carry them, and the reader
    // must treat them as "nobody declared" rather than throw at estimate time.
    const junk: Array<[string, unknown]> = [
      ['zero', 0], ['negative', -5], ['fractional', 12.5], ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY], ['a string', '200'],
      ['below the floor', PREFILL_THROUGHPUT_MIN_TOK_PER_SEC - 1],
      ['above the ceiling', PREFILL_THROUGHPUT_MAX_TOK_PER_SEC + 1],
    ];
    for (const [label, value] of junk) {
      expect(resolvePrefillThroughput(value as number, LEDGER_MEASURED), label)
        .toEqual({ tokensPerSec: 181, source: 'measured' });
    }
  });

  it('an INCOHERENT measurement is not a measurement either, and never throws', () => {
    const junk: Array<[string, unknown]> = [
      ['zero', 0], ['negative', -5], ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY], ['a string', '181'],
      ['below the floor once floored', 0.9],
      ['above the ceiling', PREFILL_THROUGHPUT_MAX_TOK_PER_SEC + 1],
    ];
    for (const [label, value] of junk) {
      expect(resolvePrefillThroughput(null, value as number), label).toBeNull();
    }
  });
});

describe('resolveDoomCeiling — the ceiling the whole ANSWER-ANYWAY chain spends', () => {
  const ceilingFor = (tokensPerSec: number): number =>
    Math.floor(((DECLARED_PATIENCE_MS - TRANSPORT_MARGIN_MS) / 1000) * tokensPerSec);

  it('⚠ THE GAP THIS TASK CLOSES: an undeclared provider used to have NO ceiling at all', () => {
    // Before the 2026-09-22 ruling this was the state of every box whose owner had not
    // benchmarked it by hand — which was all of them. `null` here means the pre-dial gate is
    // skipped, the admission budget is uncapped by the box, and the router's fit filter passes
    // everything. That is the incident's own shape.
    expect(resolveDoomCeiling(DECLARED_PATIENCE_MS, null)).toBeNull();
    // With the ledger's reading it now has one, and it is the reading's own arithmetic.
    expect(resolveDoomCeiling(DECLARED_PATIENCE_MS, null, LEDGER_MEASURED)).toBe(ceilingFor(181));
  });

  it('a DECLARED provider gets the identical ceiling it got before this task existed', () => {
    // The two-argument call is every call site that predates the ruling, and it must not have
    // moved by a token. The three-argument call with a measurement present must agree with it.
    const before = resolveDoomCeiling(DECLARED_PATIENCE_MS, OWNER_DECLARED);
    expect(before).toBe(ceilingFor(OWNER_DECLARED));
    expect(resolveDoomCeiling(DECLARED_PATIENCE_MS, OWNER_DECLARED, LEDGER_MEASURED)).toBe(before);
  });

  it('the measured ceiling is SMALLER than the declared one here, which is the safe direction', () => {
    // 181 observed against 200 claimed. Under-measuring a box makes every consumer of this
    // number more cautious, never less — the property the estimator's max-of-lower-bounds is
    // built to guarantee, asserted at the point it is actually spent.
    const measured = resolveDoomCeiling(DECLARED_PATIENCE_MS, null, LEDGER_MEASURED) as number;
    const declared = resolveDoomCeiling(DECLARED_PATIENCE_MS, OWNER_DECLARED) as number;
    expect(measured).toBeLessThan(declared);
  });

  it('still null when neither half is there', () => {
    expect(resolveDoomCeiling(DECLARED_PATIENCE_MS, null, null)).toBeNull();
  });
});

describe('providerAwareBudgetTokens — the admission budget spends the same measured ceiling', () => {
  it('caps a window-derived budget at half the measured ceiling', () => {
    const ceiling = resolveDoomCeiling(DECLARED_PATIENCE_MS, null, LEDGER_MEASURED) as number;
    expect(ceiling).not.toBeNull();
    const budget = providerAwareBudgetTokens(1_000_000, ceiling);
    expect(budget).toBe(Math.floor(ceiling * PROVIDER_CEILING_SAFETY));
    // The incident's own shape: a 60,000-token assembly on a box whose measured reading cannot
    // plan for it. Before this task the ceiling was null and nothing capped anything.
    expect(budget).toBeLessThan(60_000);
  });

  it('only ever TIGHTENS — a small model window is not widened by a measured box', () => {
    const ceiling = resolveDoomCeiling(DECLARED_PATIENCE_MS, null, LEDGER_MEASURED) as number;
    expect(providerAwareBudgetTokens(8_000, ceiling)).toBe(8_000);
  });
});
