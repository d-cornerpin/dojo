// ════════════════════════════════════════════════════════════════════════════════════════
// NO-DOOMED-DIALS T81b — A PROVIDER DECLARES ITS OWN PREFILL THROUGHPUT.
//
// ── THE DEFECT (census row 37) ──
// Both transports in `agent/model.ts` already compute a token estimate for the exact request
// about to go out, immediately before dispatch. Until this task neither number was ever
// compared against anything — a provider could declare a first-chunk patience (163) and a
// prompt could still be dialed that provably could not finish inside it, on that box, at any
// speed it has ever shown. The GPU livelock incident is what happens when nobody asks first.
//
// ── THE RULE THIS FILE PINS, MIRRORING `a-provider-declares-its-own-unattended-budget.test.ts` ──
//  1. A provider may declare its own prefill throughput, in TOKENS PER SECOND, and a coherent
//     declaration is honoured verbatim by `resolveDoomCeiling`.
//  2. `null` (or an incoherent stored value) means "declared nothing", and `resolveDoomCeiling`
//     returns `null` — no ceiling, so the pre-dial gate it feeds is a no-op. This is the
//     byte-preservation control: every provider configured before this task, and every preset
//     since, dials exactly as it does today.
//  3. The ceiling is the incident's own arithmetic, run through the SAME margin
//     `resolveTransportTimeouts` already uses (`TRANSPORT_MARGIN_MS`) — reused, not reinvented.
//  4. The bounds the reader trusts and the bounds the write door enforces are ONE pair of
//     constants (`config/schema.ts` imports the same `PREFILL_THROUGHPUT_MIN_TOK_PER_SEC` /
//     `PREFILL_THROUGHPUT_MAX_TOK_PER_SEC` this file pins), so storable always implies
//     honourable.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  resolveDoomCeiling,
  PREFILL_THROUGHPUT_MIN_TOK_PER_SEC,
  PREFILL_THROUGHPUT_MAX_TOK_PER_SEC,
  TRANSPORT_MARGIN_MS,
} from '../stream-patience.js';

describe('T81b-red-1: the bounds this task is bounded by', () => {
  it('the floor and ceiling are the ones the module declares', () => {
    expect(PREFILL_THROUGHPUT_MIN_TOK_PER_SEC).toBe(1);
    expect(PREFILL_THROUGHPUT_MAX_TOK_PER_SEC).toBe(100_000);
  });
});

describe('resolveDoomCeiling — a provider that declares nothing has no ceiling', () => {
  it('null throughput resolves to null (feature off)', () => {
    expect(resolveDoomCeiling(600_000, null)).toBeNull();
  });

  it('undefined throughput resolves to null', () => {
    expect(resolveDoomCeiling(600_000, undefined)).toBeNull();
  });
});

describe('resolveDoomCeiling — a stored value that is not coherent is not a declaration', () => {
  // Same asymmetry 163's `isCoherent` and 164's `isCoherentMinutes` document: the write door
  // refuses these shapes outright, but the reader must survive a row the door never approved
  // (a hand-edited database, a restored backup, a writer that does not exist yet) by falling
  // back to "no ceiling", not by throwing at estimate time.
  const junk: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -5],
    ['fractional', 12.5],
    ['below the floor', PREFILL_THROUGHPUT_MIN_TOK_PER_SEC - 1],
    ['above the ceiling', PREFILL_THROUGHPUT_MAX_TOK_PER_SEC + 1],
    ['NaN', Number.NaN],
    ['positive Infinity', Number.POSITIVE_INFINITY],
    ['a string', '180'],
  ];

  for (const [label, value] of junk) {
    it(`${label} resolves to null and never throws`, () => {
      expect(resolveDoomCeiling(600_000, value as number | null)).toBeNull();
    });
  }
});

describe('resolveDoomCeiling — R-FIXTURE: the incident\'s own numbers (test values, never code constants)', () => {
  // 600s declared patience, 180 tok/s declared prefill throughput. The brief's own arithmetic:
  // "ceiling ≈108K ⇒ a 110K estimate refuses, an 80K estimate dials". The margin this module
  // reuses (`TRANSPORT_MARGIN_MS`, 30s) is spent off the TIME side before the multiplication —
  // (600_000 − 30_000) / 1000 × 180 = 102,600 — which is comfortably on the correct side of
  // both fixture numbers without needing to land on the brief's own rough "≈108K" to the digit.
  it('produces a ceiling that a 110K estimate exceeds and an 80K estimate does not', () => {
    const ceiling = resolveDoomCeiling(600_000, 180);
    expect(ceiling).not.toBeNull();
    expect(110_000).toBeGreaterThan(ceiling as number);
    expect(80_000).toBeLessThanOrEqual(ceiling as number);
  });

  it('is the exact number this module\'s own margin arithmetic produces', () => {
    expect(resolveDoomCeiling(600_000, 180)).toBe(
      Math.floor(((600_000 - TRANSPORT_MARGIN_MS) / 1000) * 180),
    );
    expect(resolveDoomCeiling(600_000, 180)).toBe(102_600);
  });
});

describe('resolveDoomCeiling — the margin is floored at zero, not allowed to go negative', () => {
  it('a declared patience no longer than the margin itself produces a zero ceiling, not a negative one', () => {
    expect(resolveDoomCeiling(TRANSPORT_MARGIN_MS, 180)).toBe(0);
    expect(resolveDoomCeiling(TRANSPORT_MARGIN_MS - 1, 180)).toBe(0);
  });

  it('a zero ceiling refuses every positive estimate — the honest answer for a bound this tight', () => {
    const ceiling = resolveDoomCeiling(TRANSPORT_MARGIN_MS, 180);
    expect(1 > (ceiling as number)).toBe(true);
  });
});

describe('resolveDoomCeiling — scales with both declared facts independently', () => {
  it('doubling the declared throughput roughly doubles the ceiling', () => {
    const slow = resolveDoomCeiling(600_000, 90) as number;
    const fast = resolveDoomCeiling(600_000, 180) as number;
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBe(slow * 2);
  });

  it('a longer declared patience raises the ceiling at the same throughput', () => {
    const shortPatience = resolveDoomCeiling(600_000, 180) as number;
    const longPatience = resolveDoomCeiling(1_200_000, 180) as number;
    expect(longPatience).toBeGreaterThan(shortPatience);
  });

  it('the exact bounds are legal on both ends', () => {
    expect(resolveDoomCeiling(600_000, PREFILL_THROUGHPUT_MIN_TOK_PER_SEC)).not.toBeNull();
    expect(resolveDoomCeiling(600_000, PREFILL_THROUGHPUT_MAX_TOK_PER_SEC)).not.toBeNull();
  });
});
