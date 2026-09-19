// ════════════════════════════════════════════════════════════════════════════════════════
// SLOW-INFERENCE T79b — A PROVIDER DECLARES ITS OWN UNATTENDED BUDGET.
//
// ── THE DEFECT ──
// `agent/v2/steps/pre-call-gates/turn-budget.ts` hard-coded `MAX_TURN_AUTO_CONTINUATIONS = 3`
// on top of a 15-minute turn budget — a flat 60-minute ceiling applied identically to a
// metered cloud API and a free local box with no queue behind it, and no self-wake on trip:
// the turn simply stopped, guessed "usually means a stuck loop" at the person, and left the
// owner to notice the silence.
//
// ── THE RULE THIS FILE PINS, MIRRORING `a-provider-declares-its-own-patience.test.ts` ──
//  1. A provider may DECLARE its own unattended budget, in MINUTES, and a coherent
//     declaration is honoured verbatim.
//  2. NULL means "declared nothing", which resolves to the standing 60-minute default — and
//     that default, run through `continuationCapFor`, is EXACTLY today's continuation cap of
//     3. This is the byte-preserve control (T79b brief, R6): every provider configured before
//     this task, and every preset since, keeps the identical ladder.
//  3. `0` is a LEGAL declaration meaning NO CAP — the opposite of "broken", unlike the
//     response-patience pair's zero. `continuationCapFor` turns it into `Infinity`, which no
//     continuation count can ever exceed (the 50th continuation proceeds, same as the 5th).
//  4. A stored value the reader cannot trust (negative, fractional, out of bounds, not a
//     number at all) is NOT a declaration: it falls back to the default and never throws.
//  5. The bounds the reader trusts and the bounds the write door enforces are ONE pair of
//     constants (`config/schema.ts` imports the same `UNATTENDED_MIN_MINUTES` /
//     `UNATTENDED_MAX_MINUTES` this file pins), so storable always implies honourable.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  resolveUnattendedBudget,
  continuationCapFor,
  UNATTENDED_DEFAULT_MINUTES,
  UNATTENDED_MIN_MINUTES,
  UNATTENDED_MAX_MINUTES,
  UNCAPPED,
} from '../unattended-budget.js';

const TURN_BUDGET_MIN = 15; // TURN_TIME_BUDGET_MS / 60000, carried verbatim rather than imported

describe('T79b-red-1: the numbers this task is bounded by', () => {
  it('the default, floor, ceiling and the uncapped sentinel are the ones the brief named', () => {
    expect(UNATTENDED_DEFAULT_MINUTES).toBe(60);
    expect(UNATTENDED_MIN_MINUTES).toBe(15);
    expect(UNATTENDED_MAX_MINUTES).toBe(1440);
    expect(UNCAPPED).toBe(0);
  });
});

describe('resolveUnattendedBudget — a provider that declares nothing gets the standing default', () => {
  it('null resolves to the default', () => {
    expect(resolveUnattendedBudget(null)).toBe(UNATTENDED_DEFAULT_MINUTES);
  });

  it('undefined resolves to the default (a whole missing row)', () => {
    expect(resolveUnattendedBudget(undefined)).toBe(UNATTENDED_DEFAULT_MINUTES);
  });
});

describe('resolveUnattendedBudget — the declaration is the knob', () => {
  it('a declared budget inside the legal range is honoured verbatim', () => {
    expect(resolveUnattendedBudget(480)).toBe(480);
  });

  it('the exact bounds are legal on both ends', () => {
    expect(resolveUnattendedBudget(UNATTENDED_MIN_MINUTES)).toBe(UNATTENDED_MIN_MINUTES);
    expect(resolveUnattendedBudget(UNATTENDED_MAX_MINUTES)).toBe(UNATTENDED_MAX_MINUTES);
  });

  it('zero resolves to Infinity — NO CAP, not "broken"', () => {
    expect(resolveUnattendedBudget(UNCAPPED)).toBe(Infinity);
  });
});

describe('resolveUnattendedBudget — a stored value that is not coherent is not a declaration', () => {
  // Same asymmetry 163's `isCoherent` documents for response patience: the write door refuses
  // these shapes outright, but the reader must survive a row the door never approved (a
  // hand-edited database, a restored backup, a writer that does not exist yet) by falling
  // back, not by throwing at cap-check time.
  const junk: Array<[string, unknown]> = [
    ['negative', -1],
    ['fractional', 30.5],
    ['below the floor (and not zero)', UNATTENDED_MIN_MINUTES - 1],
    ['above the ceiling', UNATTENDED_MAX_MINUTES + 1],
    ['NaN', Number.NaN],
    ['positive Infinity', Number.POSITIVE_INFINITY],
    ['a string', '480'],
  ];

  for (const [label, value] of junk) {
    it(`${label} falls back to the default and never throws`, () => {
      expect(resolveUnattendedBudget(value as number | null)).toBe(UNATTENDED_DEFAULT_MINUTES);
    });
  }
});

describe('continuationCapFor — the ladder a resolved budget buys', () => {
  it('R6, THE NULL-ROW CONTROL: the default budget byte-preserves today\'s cap of 3', () => {
    expect(continuationCapFor(resolveUnattendedBudget(null), TURN_BUDGET_MIN)).toBe(3);
    // Restated as the brief's own arithmetic, so a future change to either function has to
    // break this line to break the control.
    expect(continuationCapFor(UNATTENDED_DEFAULT_MINUTES, TURN_BUDGET_MIN)).toBe(3);
  });

  it('a declared 480-minute budget buys 31 continuations, per the brief', () => {
    expect(continuationCapFor(resolveUnattendedBudget(480), TURN_BUDGET_MIN)).toBe(31);
  });

  it('rounds UP: a budget that does not divide evenly still gets the continuation that carries it past its own ceiling', () => {
    // 20 minutes / 15 = 1.33..., ceil = 2, minus the original turn = 1 continuation (30 min
    // total) — one continuation short of the exact declaration would be a broken promise.
    expect(continuationCapFor(resolveUnattendedBudget(20), TURN_BUDGET_MIN)).toBe(1);
  });

  it('UNCAPPED: zero resolves through to Infinity, and no continuation count exceeds it', () => {
    const cap = continuationCapFor(resolveUnattendedBudget(UNCAPPED), TURN_BUDGET_MIN);
    expect(cap).toBe(Infinity);
    // "a 50th continuation proceeds" (the brief's own RED wording) — the trip condition in
    // `turn-budget.ts` is `continuationCount > cap`, and this is that exact comparison.
    expect(50 > cap).toBe(false);
    expect(1_000_000 > cap).toBe(false);
  });

  it('the floor still trips eventually: a 15-minute budget buys zero continuations', () => {
    expect(continuationCapFor(resolveUnattendedBudget(UNATTENDED_MIN_MINUTES), TURN_BUDGET_MIN)).toBe(0);
  });
});
