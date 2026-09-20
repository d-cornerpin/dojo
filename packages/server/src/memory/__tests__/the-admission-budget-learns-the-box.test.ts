// ════════════════════════════════════════════════════════════════════════════════════════
// T82a (ANSWER-ANYWAY) — THE ADMISSION BUDGET LEARNS THE BOX.
//
// `contextWindowPolicy` (PHASE-3 T2/T4) is the ONE owner of the window, the thresholds and
// the reserve. Until this task its `assemblyBudgetTokens` was a pure function of the model's
// declared context WINDOW — it had no way to hear that the box serving that window is slow.
// This suite pins the new input: a `measured.providerCeilingTokens` that, when present, caps
// the admission budget at `providerAwareBudgetTokens`'s own arithmetic — and pins, as an equal
// and opposite requirement (R6), that the OMITTED case is byte-identical to a fixture captured
// from the pre-T82a shape of this function.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { contextWindowPolicy, OUTPUT_RESERVE_TOKENS } from '../budget.js';
import { providerAwareBudgetTokens, resolveDoomCeiling } from '../../agent/stream-patience.js';

const MEASURED_PRIMARY = { toolPayloadTokens: 17_502, maxOutputTokens: 64_000 };
const RESERVE_PRIMARY = 17_502 + OUTPUT_RESERVE_TOKENS;

// R-FIXTURE (never a code constant): the incident's own numbers. 600s declared patience,
// 180 tok/s declared prefill throughput.
const FIXTURE_CEILING = resolveDoomCeiling(600_000, 180) as number; // 102,600

describe('contextWindowPolicy — RED: a declared provider ceiling caps the admission budget', () => {
  it('the fixture: on a 200K window the admission budget lands at ~51,300, not ~184,402', () => {
    const withoutCeiling = contextWindowPolicy(200_000, MEASURED_PRIMARY);
    // Control: the raw, window-derived budget this task must shrink.
    expect(withoutCeiling.assemblyBudgetTokens).toBe(Math.floor(0.96 * 200_000) - RESERVE_PRIMARY);
    expect(withoutCeiling.assemblyBudgetTokens).toBeGreaterThan(102_600);

    const withCeiling = contextWindowPolicy(200_000, {
      ...MEASURED_PRIMARY,
      providerCeilingTokens: FIXTURE_CEILING,
    });
    expect(withCeiling.assemblyBudgetTokens).toBe(
      providerAwareBudgetTokens(withoutCeiling.assemblyBudgetTokens, FIXTURE_CEILING),
    );
    expect(withCeiling.assemblyBudgetTokens).toBe(51_300);

    // A would-be-60K assembly no longer fits admission — it must trim BEFORE any dial.
    expect(60_000).toBeGreaterThan(withCeiling.assemblyBudgetTokens);
  });

  it('a SMALL window is never WIDENED by a fast box\'s ceiling — the cap only ever tightens', () => {
    const p = contextWindowPolicy(20_000, { ...MEASURED_PRIMARY, providerCeilingTokens: FIXTURE_CEILING });
    const q = contextWindowPolicy(20_000, MEASURED_PRIMARY);
    expect(p.assemblyBudgetTokens).toBe(q.assemblyBudgetTokens);
  });

  it('never goes negative when the provider ceiling is present', () => {
    const p = contextWindowPolicy(8_000, { toolPayloadTokens: 90_000, providerCeilingTokens: FIXTURE_CEILING });
    expect(p.assemblyBudgetTokens).toBe(0);
  });

  it('every OTHER field of the policy is untouched by the provider ceiling', () => {
    const p = contextWindowPolicy(200_000, { ...MEASURED_PRIMARY, providerCeilingTokens: FIXTURE_CEILING });
    const q = contextWindowPolicy(200_000, MEASURED_PRIMARY);
    expect(p.contextWindow).toBe(q.contextWindow);
    expect(p.compactionThreshold).toBe(q.compactionThreshold);
    expect(p.warnThreshold).toBe(q.warnThreshold);
    expect(p.blockThreshold).toBe(q.blockThreshold);
    expect(p.toolAndOutputReserve).toBe(q.toolAndOutputReserve);
    expect(p.freshTailCount).toBe(q.freshTailCount);
    expect(p.gateMessageCap).toBe(q.gateMessageCap);
    expect(p.summaryShare).toBe(q.summaryShare);
  });
});

// ── R6: NULL THROUGHPUT OR NULL PATIENCE ⇒ BYTE-IDENTICAL TO TODAY ──────────────────────────
//
// A fixture captured from the function's shape BEFORE this task touched it (the exact
// expression `budget.test.ts` already pins at `p.assemblyBudgetTokens ===
// Math.floor(0.96 * cw) - RESERVE_PRIMARY`). Pinning the number itself, not just the
// expression, is what makes this a control against a REGRESSION in the new code path rather
// than a restatement of the formula the new code path could still both share and break.
describe('contextWindowPolicy — CONTROL (byte-preservation, R6): the pre-T82a fixture never moves', () => {
  const PRE_T82A_FIXTURE = 170_402; // floor(0.96 * 200_000) - (17_502 + 4096), captured pre-change

  it('providerCeilingTokens omitted is byte-identical to the captured pre-change fixture', () => {
    const p = contextWindowPolicy(200_000, MEASURED_PRIMARY);
    expect(p.assemblyBudgetTokens).toBe(PRE_T82A_FIXTURE);
  });

  it('providerCeilingTokens explicitly null is byte-identical to the captured pre-change fixture', () => {
    const p = contextWindowPolicy(200_000, { ...MEASURED_PRIMARY, providerCeilingTokens: null });
    expect(p.assemblyBudgetTokens).toBe(PRE_T82A_FIXTURE);
  });

  it('is a pure function of the window when no ceiling is supplied — same input, same output', () => {
    expect(contextWindowPolicy(128_000, MEASURED_PRIMARY)).toEqual(contextWindowPolicy(128_000, MEASURED_PRIMARY));
  });
});
