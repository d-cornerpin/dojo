// t172 — WHAT MAKES A REPEATED CALL A REPEAT: the signature, the per-task seen-set, the counts.
//
// `effort-ledger.ts` is the in-memory ledger that decides whether each charged call is NEW or a
// REPEAT, which is what feeds the effort meter (repeats move it, new calls do not) and the PM's
// "is this task advancing" check-ins. Nothing else pins its signature canonicalisation, its
// repeat counting within and across batches, or its per-turn novelty count, so this file does:
//   §1 `callSignature` — key order at every depth and `undefined` values must not change what a
//      call IS; a different value or a different tool name must.
//   §2 `chargeEffortCalls` — the one write (taskId, total, distinct) and the per-task novelty
//      facts one batch produces, split into new calls and repeats.
//   §3 repeats counted ACROSS batches (a signature seen in an earlier batch is a repeat), ranked
//      most-repeated first.
//   §4 an empty batch charges nothing and holds no facts.
//   §5 `novelCallsInTurn` — the new calls that SUCCEEDED in one turn, which accumulate across
//      charges to the same turn and read 0 for any other turn.
//   §6 `forgetTaskCalls` — the task advancing clears the ledger.
//
// The only module dependency is `work/effort-meter.js`'s `writeEffortCharge` (the database write
// of the two durable columns), so it is the one mock here.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { writeEffortCharge } = vi.hoisted(() => ({ writeEffortCharge: vi.fn() }));
vi.mock('../../work/effort-meter.js', () => ({ writeEffortCharge }));

import {
  callSignature,
  chargeEffortCalls,
  effortNoveltyFacts,
  novelCallsInTurn,
  forgetTaskCalls,
} from '../effort-ledger.js';

beforeEach(() => {
  writeEffortCharge.mockClear();
  forgetTaskCalls('t1');
  forgetTaskCalls('t2');
});

// ════════════════════════════════════════════════════════════════════════════════
// §1 — callSignature: the canonical form of what a call IS
// ════════════════════════════════════════════════════════════════════════════════

describe('§1 callSignature — canonicalisation makes the same call the same call', () => {
  it('key order at every depth and undefined values do not matter', () => {
    expect(callSignature({ name: 'x', arguments: { a: 1, b: { y: 2, x: 1 } } })).toBe(
      callSignature({ name: 'x', arguments: { b: { x: 1, y: 2 }, a: 1, c: undefined } }),
    );
  });

  it('a call with no arguments is the same call as one with an empty object of arguments', () => {
    expect(callSignature({ name: 'x' })).toBe(callSignature({ name: 'x', arguments: {} }));
  });

  it('different argument VALUES are different calls', () => {
    expect(callSignature({ name: 'x', arguments: { p: { title: 'a' } } })).not.toBe(
      callSignature({ name: 'x', arguments: { p: { title: 'b' } } }),
    );
  });

  it('different tool NAMES are different calls', () => {
    expect(callSignature({ name: 'x' })).not.toBe(callSignature({ name: 'y' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §2 — chargeEffortCalls: the write and the per-task novelty facts
// ════════════════════════════════════════════════════════════════════════════════

describe('§2 chargeEffortCalls — the write and the per-task novelty facts', () => {
  it('one batch: writes (taskId, total, distinct) and splits the facts into new calls and repeats', () => {
    chargeEffortCalls('t1', [
      { name: 'a', arguments: { q: 1 } },
      { name: 'a', arguments: { q: 1 } },
      { name: 'b' },
    ]);
    expect(writeEffortCharge).toHaveBeenCalledWith('t1', 3, 2);
    expect(effortNoveltyFacts('t1')).toEqual({
      novelCalls: 2,
      repeatedCalls: 1,
      repeatedSignatures: [{ label: 'a({"q":1})', count: 1 }],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §3 — repeats counted across batches, ranked most-repeated first
// ════════════════════════════════════════════════════════════════════════════════

describe('§3 repeats count ACROSS batches and rank most-first', () => {
  it('a signature seen in an earlier batch is a repeat in a later batch, ranked by count', () => {
    chargeEffortCalls('t1', [{ name: 'a' }, { name: 'b' }]);
    chargeEffortCalls('t1', [{ name: 'a' }, { name: 'a' }, { name: 'b' }]);
    expect(writeEffortCharge).toHaveBeenLastCalledWith('t1', 3, 0);
    expect(effortNoveltyFacts('t1')).toEqual({
      novelCalls: 2,
      repeatedCalls: 3,
      repeatedSignatures: [
        { label: 'a({})', count: 2 },
        { label: 'b({})', count: 1 },
      ],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §4 — an empty batch charges nothing
// ════════════════════════════════════════════════════════════════════════════════

describe('§4 an empty batch charges nothing', () => {
  it('no calls: no write, and no facts are held for the task', () => {
    chargeEffortCalls('t2', []);
    expect(writeEffortCharge).not.toHaveBeenCalled();
    expect(effortNoveltyFacts('t2')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §5 — novelCallsInTurn: new SUCCESSFUL calls in one turn
// ════════════════════════════════════════════════════════════════════════════════

describe('§5 novelCallsInTurn — new SUCCESSFUL calls in one turn, accumulating', () => {
  it('only new calls that SUCCEEDED count in the turn they were charged to, and a second charge to the SAME turn accumulates', () => {
    chargeEffortCalls('t1', [{ name: 'a' }, { name: 'a' }, { name: 'b' }], {
      startMs: 100,
      succeeded: (c) => c.name === 'a',
    });
    expect(novelCallsInTurn('t1', 100)).toBe(1);
    expect(novelCallsInTurn('t1', 101)).toBe(0);
    chargeEffortCalls('t1', [{ name: 'c' }], {
      startMs: 100,
      succeeded: () => true,
    });
    expect(novelCallsInTurn('t1', 100)).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// §6 — forgetTaskCalls: the task advancing clears the ledger
// ════════════════════════════════════════════════════════════════════════════════

describe('§6 forgetTaskCalls — the task advancing clears the ledger', () => {
  it('after forgetting, no novelty facts are held', () => {
    chargeEffortCalls('t1', [{ name: 'a' }]);
    expect(effortNoveltyFacts('t1')).not.toBeNull();
    forgetTaskCalls('t1');
    expect(effortNoveltyFacts('t1')).toBeNull();
  });
});
