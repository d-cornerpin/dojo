// ⚠ THE RECOMMENDATION THAT TOOK A MACHINE DOWN (t88 capture-3 audit).
//
// A 4b utility model on a 16 GB desktop box was "recommended" a 28,672-token window. Measured result:
// the runtime loaded at 5.4 GB resident, system wired memory went 1.3 GB → 6.4 GB, free pages collapsed
// to ~60 MB, and the whole machine stopped responding for the keep-alive window with NO agent activity.
//
// The old arithmetic was `installed RAM − headroom(4-8 GiB) − this model's weights`, as though the box
// had nothing else to do. These clauses are the box's actual obligations: a desktop session, the engine,
// and the other local models Ollama keeps resident.
import { describe, it, expect } from 'vitest';
import {
  kvBudgetBytes, pickDesktopReserve, otherResidentWeights, ENGINE_RESERVE_BYTES,
} from '../num-ctx-calculator.js';

const GIB = 1024 ** 3;
/** The box in the incident. */
const SIXTEEN_GB = 16 * GIB;
/** A 4b model's weights, as /api/tags reported them. */
const SMALL_MODEL_WEIGHTS = Math.floor(2.5 * GIB);
/** ~90 KiB per token for that model's KV cache (2 × 36 blocks × 8 kv-heads × 80 head-dim × 2 bytes). */
const KV_BYTES_PER_TOKEN = 2 * 36 * 8 * 80 * 2;

describe('the desktop reserve is the number the incident taught', () => {
  it('⚠ AT LEAST 6 GiB — the old 4 GiB floor is what was promised while 10 GB was in use', () => {
    // When the model held 5.4 GB of a 16 GB box, free pages were ~60 MB: everything else wanted about
    // 10 GB and had been budgeted 4. macOS with a browser and a screen-sharing session is a
    // multi-gigabyte obligation.
    expect(pickDesktopReserve(SIXTEEN_GB)).toBeGreaterThanOrEqual(6 * GIB);
    expect(pickDesktopReserve(8 * GIB)).toBeGreaterThanOrEqual(6 * GIB);
  });

  it('grows with the box, because a bigger machine runs bigger other things — but is capped', () => {
    expect(pickDesktopReserve(64 * GIB)).toBeGreaterThan(pickDesktopReserve(SIXTEEN_GB));
    // …and a 128 GB workstation is not told to hold back 38 GB.
    expect(pickDesktopReserve(128 * GIB)).toBeLessThanOrEqual(12 * GIB);
  });

  it('⚠ THE OLD 12.5% WAS NEVER THE POLICY ON A SMALL BOX, which is why it read as safe', () => {
    // 12.5% of 16 GiB is 2 GiB — below the old 4 GiB floor — so the floor WAS the answer for every box
    // up to 32 GiB. The percentage only did anything on machines that were never at risk.
    expect(Math.floor(SIXTEEN_GB * 0.125)).toBeLessThan(4 * GIB);
    expect(pickDesktopReserve(SIXTEEN_GB)).toBeGreaterThan(Math.floor(SIXTEEN_GB * 0.125));
  });
});

describe('the budget is against the whole box, not installed RAM', () => {
  const oldPolicyAvailable = (total: number, weights: number): number => {
    const headroom = Math.max(4 * GIB, Math.min(8 * GIB, Math.floor(total * 0.125)));
    return total - headroom - weights;
  };

  it('⚠ THE INCIDENT, IN ONE COMPARISON: the old budget vs the new one on that box', () => {
    const embedder = Math.floor(0.3 * GIB);
    const now = kvBudgetBytes({
      totalRamBytes: SIXTEEN_GB,
      weightsBytes: SMALL_MODEL_WEIGHTS,
      otherResidentWeightsBytes: embedder,
    });
    const before = oldPolicyAvailable(SIXTEEN_GB, SMALL_MODEL_WEIGHTS);
    // The old policy offered ~9.5 GiB of KV cache on a box whose desktop, engine and embedder were
    // already holding ~8 GiB. The new budget subtracts all three.
    expect(before).toBeGreaterThan(9 * GIB);
    expect(now).toBeLessThan(before - 3 * GIB);
  });

  it('⚠ AND THE HONEST LIMIT OF THIS FIX, measured rather than claimed', () => {
    // ⚠ THE AUDIT DOES NOT, BY ITSELF, PREVENT THE INCIDENT — and saying so here is the point.
    // For a SMALL model the KV cache is cheap per token: this 4b model's whole architectural context
    // (28,672 tokens) costs ~2.5 GiB, so even the CORRECTED budget still exceeds it and the
    // recommendation still lands on "the model's maximum". The accounting was genuinely wrong and is
    // genuinely fixed — a 14b model on this box now gets a sane number where it used to get a
    // dangerous one — but the thing that actually protected this box is `agent/utility-dial.ts`
    // sizing each CALL (a title asks for ~2,048 tokens whatever the recommendation says).
    //
    // This clause exists so nobody reads the audit as the cure. If a future change makes the budget
    // bite for small models too, this clause fails and the comment above gets rewritten with it.
    const now = kvBudgetBytes({
      totalRamBytes: SIXTEEN_GB,
      weightsBytes: SMALL_MODEL_WEIGHTS,
      otherResidentWeightsBytes: Math.floor(0.3 * GIB),
    });
    const smallModelFullContextCost = 28_672 * KV_BYTES_PER_TOKEN;
    expect(smallModelFullContextCost).toBeLessThan(3 * GIB);
    expect(now).toBeGreaterThan(smallModelFullContextCost);      // → still clamps to the model max

    // Where the audit DOES bite: a big model on the same box. The old policy would have promised it
    // 3.5 GiB of KV cache on a machine that had nothing like that to give.
    const bigWeights = Math.floor(6 * GIB);
    expect(oldPolicyAvailable(SIXTEEN_GB, bigWeights)).toBeGreaterThan(3 * GIB);
    expect(kvBudgetBytes({
      totalRamBytes: SIXTEEN_GB, weightsBytes: bigWeights, otherResidentWeightsBytes: Math.floor(0.3 * GIB),
    })).toBeLessThan(2.5 * GIB);
  });

  it('every obligation is actually subtracted, and each one matters on its own', () => {
    const base = { totalRamBytes: SIXTEEN_GB, weightsBytes: SMALL_MODEL_WEIGHTS, otherResidentWeightsBytes: 0 };
    const withEmbedder = kvBudgetBytes({ ...base, otherResidentWeightsBytes: GIB });
    // ⚠ THE OTHER RESIDENT MODELS TERM IS REAL: Ollama's keep_alive means "resident", so two models
    // each sized as if alone are both in memory and the box holds the sum.
    expect(withEmbedder).toBe(kvBudgetBytes(base) - GIB);
    // The engine's own process is a named reserve rather than an afterthought.
    expect(ENGINE_RESERVE_BYTES).toBeGreaterThan(0);
    expect(kvBudgetBytes(base)).toBe(
      SIXTEEN_GB - pickDesktopReserve(SIXTEEN_GB) - ENGINE_RESERVE_BYTES - SMALL_MODEL_WEIGHTS,
    );
  });

  it('a box with no room comes out NEGATIVE rather than optimistic', () => {
    // 8 GB box, a 7 GB model: there is no honest window here, and the caller turns this into the floor
    // rather than into "no recommendation", because no recommendation means Ollama picks.
    const budget = kvBudgetBytes({
      totalRamBytes: 8 * GIB, weightsBytes: 7 * GIB, otherResidentWeightsBytes: 0,
    });
    expect(budget).toBeLessThan(0);
  });

  it('a big box still gets a big window — this is not a blanket shrink', () => {
    const budget = kvBudgetBytes({
      totalRamBytes: 128 * GIB, weightsBytes: 40 * GIB, otherResidentWeightsBytes: 2 * GIB,
    });
    expect(budget).toBeGreaterThan(70 * GIB);
  });
});

describe('the other-resident-models reserve reads the runtime, not a column', () => {
  const installed = [
    { name: 'small-local:4b', size: Math.floor(2.5 * GIB) },
    { name: 'an-embedder:latest', size: Math.floor(0.3 * GIB) },
    { name: 'a-bigger-local:14b', size: Math.floor(9 * GIB) },
    { name: 'not-registered:7b', size: Math.floor(4 * GIB) },
  ];

  it('sums the ENABLED registered models and excludes the one being sized', () => {
    const sum = otherResidentWeights('small-local:4b', installed,
      ['small-local:4b', 'an-embedder:latest', 'a-bigger-local:14b']);
    expect(sum).toBe(Math.floor(0.3 * GIB) + Math.floor(9 * GIB));
  });

  it('⚠ AND IT IS NOT A SILENT ZERO — the first version read a column that does not exist', () => {
    // That version sat inside a try/catch, so this reserve would have been zero forever: a term that
    // looks like diligence and does nothing. The sizes come from the runtime's own /api/tags, which is
    // already fetched for this model's weights.
    expect(otherResidentWeights('small-local:4b', installed, ['small-local:4b', 'an-embedder:latest']))
      .toBeGreaterThan(0);
    // A model installed but NOT registered with the platform is not counted: it will not be kept
    // resident by this engine's use.
    expect(otherResidentWeights('small-local:4b', installed, ['small-local:4b', 'not-registered:7b']))
      .toBe(Math.floor(4 * GIB));
    // Nothing else registered → nothing to reserve.
    expect(otherResidentWeights('small-local:4b', installed, ['small-local:4b'])).toBe(0);
  });
});
