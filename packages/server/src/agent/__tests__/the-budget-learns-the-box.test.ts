// ════════════════════════════════════════════════════════════════════════════════════
// T82a (ANSWER-ANYWAY) — THE BUDGET LEARNS THE BOX.
//
// T81b taught `agent/model.ts` to REFUSE a request the declared facts say cannot finish
// (`resolveDoomCeiling` + `refuseIfDoomed`) — a backstop that fires immediately before the
// dial. Nothing upstream of that gate ever shrank what the ASSEMBLER was willing to admit, so
// the gate's own incident (a 60K-token assembly for a one-line question, on a box whose
// declared patience covers ~102.6K in 600s) could still happen: the admission budget knew the
// model's context WINDOW but not the box's SPEED.
//
// `providerAwareBudgetTokens` is the one new function this task adds: it caps an
// already-computed token budget at half the box's coverable ceiling, so the SAME arithmetic
// `resolveDoomCeiling` already produces becomes an INPUT to the admission budget
// (`memory/budget.ts`) instead of a check the assembler's own math never saw coming.
//
// R-FIXTURE (never a code constant): 600s declared patience, 180 tok/s declared prefill
// throughput — `resolveDoomCeiling(600_000, 180) === 102_600` (pinned already by
// `a-provider-declares-its-own-prefill-throughput.test.ts`). Half of that is 51,300.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import {
  providerAwareBudgetTokens,
  PROVIDER_CEILING_SAFETY,
  resolveDoomCeiling,
} from '../stream-patience.js';

const FIXTURE_CEILING = resolveDoomCeiling(600_000, 180) as number; // 102,600

describe('PROVIDER_CEILING_SAFETY — the argued constant', () => {
  it('is one half — a healthy prefill fits in roughly half the declared patience', () => {
    expect(PROVIDER_CEILING_SAFETY).toBe(0.5);
  });
});

describe('providerAwareBudgetTokens — RED: caps the model-window budget at the box-speed ceiling', () => {
  it('the fixture: 600s/180tps ⇒ ceiling ≈102,600 ⇒ working budget ≈51,300', () => {
    expect(FIXTURE_CEILING).toBe(102_600);
    const modelCtxBudget = 184_000; // a real 200K-window model's admission budget, post-reserve
    expect(providerAwareBudgetTokens(modelCtxBudget, FIXTURE_CEILING)).toBe(51_300);
  });

  it('is exactly min(modelCtxBudget, floor(ceiling * PROVIDER_CEILING_SAFETY)) — the stated formula', () => {
    expect(providerAwareBudgetTokens(184_000, FIXTURE_CEILING)).toBe(
      Math.min(184_000, Math.floor(FIXTURE_CEILING * PROVIDER_CEILING_SAFETY)),
    );
  });

  it('a model budget already SMALLER than the box-speed ceiling is left alone — the min never widens', () => {
    // A small model window (e.g. 32K) legitimately produces an admission budget under 51,300
    // already; the provider ceiling must never be the reason a SMALL budget grows.
    expect(providerAwareBudgetTokens(9_000, FIXTURE_CEILING)).toBe(9_000);
  });

  it('a zero ceiling caps the budget at zero, not a negative number', () => {
    expect(providerAwareBudgetTokens(50_000, 0)).toBe(0);
  });

  it('never returns a number larger than either input', () => {
    for (const [budget, ceiling] of [[1, 1], [999_999, 1], [1, 999_999], [0, 0]] as const) {
      const out = providerAwareBudgetTokens(budget, ceiling);
      expect(out).toBeLessThanOrEqual(budget);
      expect(out).toBeLessThanOrEqual(ceiling);
    }
  });
});
