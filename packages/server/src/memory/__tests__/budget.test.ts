// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T2 Step 1 — ONE budget, ONE estimator. Written RED-first.
//
// Every clause here fails at T2's base commit (`cbfe13b`) because `memory/budget.ts` does
// not exist and the numbers it owns are declared in five modules that disagree:
//
//   contextThreshold   memory/assembler.ts:26        0.75   ← the assembler's fill fraction
//                      memory/compaction.ts:209      0.96   ← the compaction gate
//                      agent/v2/classifiers/compaction.ts:38  0.96 (COMPACT_THRESHOLD)
//                      memory/compaction.ts:529      0.96 + 0.90, written as literals
//   reserve            memory/assembler.ts:670       15000  (a LOCAL literal)
//                      memory/compaction.ts:82       15000  (the exported const)
//   assembly budget    memory/assembler.ts:671       floor(0.75·cw) − 15000
//                      memory/compaction.ts:123      floor(0.96·cw) − 15000  ← models the
//                                                    SAME number with a different threshold
//
// The owner DECIDED the threshold on 2026-07-26 (PHASE-3 T0b): **0.96**, keep current
// behaviour, fuller context and rarer compaction, with the existing 0.90 warn line. This
// suite pins that decision so no later task can re-derive it wrong.
//
// THE ESTIMATOR. §T0-C measured six implementations plus a SQL dialect (/4, /3.5, /3, /4,
// /3, /3, and `LENGTH(content)/4` in SQL). Their divisors are not a matter of taste — they
// are a claim about reality, so T2 measured reality before choosing:
//
//   1,409 real context receipts matched to their own `cost_records` row (agent + instant),
//   primary agent `Kevin`, tools payload measured live at 70,006 chars:
//       chars per token = 3.88 – 3.93   (per-call p10 3.78 · median 3.92 · p90 3.99)
//
//   /4   → 2% under the measured cost   ← the survivor, and already the column's dialect
//   /3.5 → 12% over
//   /3   → 30% over
//
// A 30% over-estimate is not "conservative", it is the assembler dropping history the
// window did not require — which is the same defect Step 3b fixes in the stored column.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  CHARS_PER_TOKEN,
  estimateTokens,
  estimateStoredTokens,
  getFreshTailCount,
  contextWindowPolicy,
  assertSystemPromptFits,
  SystemPromptTooLargeError,
  CONTEXT_THRESHOLD,
  CONTEXT_WARN_THRESHOLD,
  CONTEXT_BLOCK_THRESHOLD,
  OUTPUT_RESERVE_TOKENS,
  toolAndOutputReserve,
} from '../budget.js';

describe('the ONE estimator', () => {
  it('divides by 4 — the divisor the measurement chose, not the one inherited', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(401))).toBe(101); // ceil, never floor
    expect(estimateTokens('')).toBe(0);
  });

  it('estimateStoredTokens is estimateTokens with the row-cost floor, not a second estimator', () => {
    // `message-store.ts` has always applied `Math.max(1, …)` at the write site:
    // "never zero: a row that costs nothing to carry does not exist". That floor is
    // part of the STORED-ROW job, not part of estimating a string, so it gets a name
    // instead of being re-typed at every write site.
    expect(estimateStoredTokens('')).toBe(1);
    expect(estimateStoredTokens('abc')).toBe(1);
    expect(estimateStoredTokens('a'.repeat(400))).toBe(estimateTokens('a'.repeat(400)));
  });

  it('is monotone and never negative for any input the tree can hand it', () => {
    let last = -1;
    for (const n of [0, 1, 3, 4, 5, 99, 100, 4001, 1_000_000]) {
      const t = estimateTokens('x'.repeat(n));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });
});

describe('the ONE threshold (owner ruling, PHASE-3 T0b, 2026-07-26)', () => {
  it('is 0.96 with the 0.90 warn line and the 0.99 block line', () => {
    expect(CONTEXT_THRESHOLD).toBe(0.96);
    expect(CONTEXT_WARN_THRESHOLD).toBe(0.90);
    expect(CONTEXT_BLOCK_THRESHOLD).toBe(0.99);
  });

  it('orders warn < compact < block, so no window can skip a rung', () => {
    expect(CONTEXT_WARN_THRESHOLD).toBeLessThan(CONTEXT_THRESHOLD);
    expect(CONTEXT_THRESHOLD).toBeLessThan(CONTEXT_BLOCK_THRESHOLD);
  });
});

// PHASE-3 T4: `contextWindowPolicy` no longer has a reserve constant to fall back on —
// `measured` is REQUIRED, by design. These clauses pass the primary agent's own live
// figure (70,006 chars of tool schemas = 17,502 tokens, re-measured at T4's HEAD by
// `check-cache-prefix`) so the arithmetic below is the arithmetic that actually runs.
const MEASURED_PRIMARY = { toolPayloadTokens: 17_502, maxOutputTokens: 64_000 };
const RESERVE_PRIMARY = 17_502 + OUTPUT_RESERVE_TOKENS;

describe('the reserve — DERIVED from the measured payload, never a constant (PHASE-3 T4)', () => {
  it('is the measured tools payload PLUS the derived output allowance', () => {
    expect(toolAndOutputReserve(MEASURED_PRIMARY)).toBe(RESERVE_PRIMARY);
    // and it MOVES with the payload, which a constant cannot do: a sub-agent carrying a
    // third of the primary's schemas reserves a third of the tools half.
    expect(toolAndOutputReserve({ toolPayloadTokens: 5_800, maxOutputTokens: 64_000 }))
      .toBe(5_800 + OUTPUT_RESERVE_TOKENS);
  });

  it('the output half is the transports own floor, not a number this module picked', () => {
    // `agent/model.ts`'s Anthropic `minOutputReserve = 4096`, the stricter of the two the
    // tree enforces. Measured against 8,244 real `cost_records` rows it covers p99.9
    // (3,121) with headroom. See budget.ts for the full derivation and the command.
    expect(OUTPUT_RESERVE_TOKENS).toBe(4096);
  });

  it('caps the output half at what the model can actually emit', () => {
    // Reserving 4,096 from a model that tops out at 2,048 sets aside room nothing can use.
    expect(toolAndOutputReserve({ toolPayloadTokens: 1_000, maxOutputTokens: 2_048 }))
      .toBe(1_000 + 2_048);
    // An unknown cap uses the floor rather than inventing one.
    expect(toolAndOutputReserve({ toolPayloadTokens: 1_000 })).toBe(1_000 + OUTPUT_RESERVE_TOKENS);
  });

  it('THE OLD 15,000 WAS SMALLER THAN THE TOOL SCHEMAS ALONE — the defect, in arithmetic', () => {
    // What the wire carried before T4: assemblyBudget + tools, i.e. the ceiling the
    // assembler enforced was ABOVE the window before a single output token.
    const cw = 32_000;
    const oldBudget = Math.floor(0.96 * cw) - 15_000;
    expect(oldBudget + MEASURED_PRIMARY.toolPayloadTokens).toBeGreaterThan(cw);   // 33,222 > 32,000

    // With the reserve honest it closes exactly: budget + tools + output = floor(0.96·cw).
    const p = contextWindowPolicy(cw, MEASURED_PRIMARY);
    expect(p.assemblyBudgetTokens + p.toolAndOutputReserve).toBe(Math.floor(0.96 * cw));
    expect(p.assemblyBudgetTokens + MEASURED_PRIMARY.toolPayloadTokens).toBeLessThan(cw);
  });

  it('never goes negative on a payload bigger than the window', () => {
    const p = contextWindowPolicy(8_000, { toolPayloadTokens: 90_000 });
    expect(p.assemblyBudgetTokens).toBe(0);
  });
});

describe('ContextWindowPolicy — the numbers, in one place, clamped', () => {
  it('derives the assembly budget the assembler and the compaction gate BOTH used to derive privately', () => {
    const p = contextWindowPolicy(200_000, MEASURED_PRIMARY);
    expect(p.contextWindow).toBe(200_000);
    expect(p.compactionThreshold).toBe(0.96);
    expect(p.toolAndOutputReserve).toBe(RESERVE_PRIMARY);
    expect(p.assemblyBudgetTokens).toBe(Math.floor(0.96 * 200_000) - RESERVE_PRIMARY);
    expect(p.freshTailCount).toBe(getFreshTailCount(200_000));
    expect(p.gateMessageCap).toBe(4000);
    expect(p.summaryShare).toBe(0.7);
  });

  it('CLAMPS every number at zero — the cw<=20K negative-budget class becomes representable', () => {
    // At 0.96·15,000 − 15,000 the arithmetic is NEGATIVE. Today that negative flows
    // into `budgetFreshTail(tail, maxTokens - usedTokens)`, whose "include the last
    // group anyway" safety then hands the model exactly one message with no warning
    // anywhere. A clamped zero cannot silently invert a comparison.
    const p = contextWindowPolicy(15_000, MEASURED_PRIMARY);
    expect(p.assemblyBudgetTokens).toBe(0);
    expect(p.assemblyBudgetTokens).toBeGreaterThanOrEqual(0);

    for (const cw of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const q = contextWindowPolicy(cw, MEASURED_PRIMARY);
      expect(Number.isFinite(q.contextWindow)).toBe(true);
      expect(q.contextWindow).toBeGreaterThanOrEqual(0);
      expect(q.assemblyBudgetTokens).toBeGreaterThanOrEqual(0);
      expect(q.freshTailCount).toBeGreaterThan(0);
    }
  });

  it('keeps the fresh-tail ladder byte-identical to the one store.ts owned (FA-M3)', () => {
    expect(getFreshTailCount(200_000)).toBe(80);
    expect(getFreshTailCount(204_800)).toBe(80);
    expect(getFreshTailCount(128_000)).toBe(64);
    expect(getFreshTailCount(199_999)).toBe(64);
    expect(getFreshTailCount(32_000)).toBe(40);
    expect(getFreshTailCount(31_999)).toBe(24);
    expect(getFreshTailCount(4_096)).toBe(24);
  });

  it('is a pure function of the window — same window in, same numbers out', () => {
    expect(contextWindowPolicy(128_000, MEASURED_PRIMARY)).toEqual(contextWindowPolicy(128_000, MEASURED_PRIMARY));
  });
});

describe('the small-window floor — a loud failure, never a silent starvation', () => {
  it('throws when the system prompt alone exceeds the assembly budget', () => {
    // budget = 19,200 - (17,502 + 4,096) = 0 after clamping, so ANY system prompt is too big.
    const p = contextWindowPolicy(20_000, MEASURED_PRIMARY);
    expect(() => assertSystemPromptFits(7_022, p)).toThrow(SystemPromptTooLargeError);
    // and the message has to carry the numbers, because the fix is always
    // "which of these three is wrong", never "context is full"
    try {
      assertSystemPromptFits(7_022, p);
    } catch (e) {
      expect(String((e as Error).message)).toContain('7022');
      expect(String((e as Error).message)).toContain('20000');
      // the reserve is now IN the message, because "which of the three is wrong" gained a
      // third answer the moment the reserve stopped being a constant everyone knew.
      expect(String((e as Error).message)).toContain(String(RESERVE_PRIMARY));
    }
  });

  it('does NOT throw for the windows the platform actually runs on', () => {
    // §T0-E measured the real system prompt at a median of 28,085 chars ≈ 7,022 tokens.
    for (const cw of [32_000, 65_536, 128_000, 200_000, 204_800, 1_048_576]) {
      expect(() => assertSystemPromptFits(7_022, contextWindowPolicy(cw, MEASURED_PRIMARY))).not.toThrow();
    }
  });

  it('throws on the exact boundary + 1 and passes ON the boundary', () => {
    const p = contextWindowPolicy(200_000, MEASURED_PRIMARY);
    expect(() => assertSystemPromptFits(p.assemblyBudgetTokens, p)).not.toThrow();
    expect(() => assertSystemPromptFits(p.assemblyBudgetTokens + 1, p)).toThrow(SystemPromptTooLargeError);
  });
});
