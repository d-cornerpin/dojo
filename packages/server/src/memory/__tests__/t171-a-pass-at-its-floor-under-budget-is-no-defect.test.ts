// t171 (Run 10 S4): "COMPACTION_DEFECT a pass ended over budget having reclaimed nothing" fired for
// a pass that ended UNDER budget (12,264 of 15,360) and DID reclaim (961 tokens, 18 parents),
// because its condensation stage was named `single_summary_at_floor`. A floor is not a refusal:
// the one summary left is already as small as condensing goes, and nothing is broken to repair.
// OR-COMPACT-1 part 3 still holds for a REFUSAL (the writer refused, threw, or is unavailable):
// that is reported even under budget. A floor stage is reported only when the pass is over budget.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const reported: Array<{ stage: string }> = [];
vi.mock('../compaction-defect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compaction-defect.js')>();
  return {
    ...actual,
    reportCompactionDefect: (_agentId: string, stage: string) => {
      reported.push({ stage });
      return { reason: stage } as unknown as ReturnType<typeof actual.reportCompactionDefect>;
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { ...actual, createLogger: () => quiet };
});

import { notePassOutcome, __resetBrakesForTests } from '../compaction-brakes.js';

const won = { leafCreated: 0, condensedCreated: 18, tokensReclaimed: 961 };
const facts = (stage: string, assembledTokens: number) =>
  ({ stage, assembledTokens, budgetTokens: 15360 }) as unknown as Parameters<typeof notePassOutcome>[3];

describe('t171: a pass at its floor, under budget, is not a compaction defect', () => {
  beforeEach(() => { reported.length = 0; __resetBrakesForTests(); });

  it('the measured shape (single_summary_at_floor, 12,264 of 15,360, 961 reclaimed) reports nothing', () => {
    notePassOutcome('a1', true, won, facts('single_summary_at_floor', 12264));
    expect(reported).toEqual([]);
  });

  it('nothing_left_to_condense under budget reports nothing', () => {
    notePassOutcome('a2', true, won, facts('nothing_left_to_condense', 12264));
    expect(reported).toEqual([]);
  });

  it('a floor stage OVER budget is still a defect', () => {
    notePassOutcome('a3', true, won, facts('single_summary_at_floor', 16000));
    expect(reported.map((r) => r.stage)).toEqual(['single_summary_at_floor']);
  });

  it('a named REFUSAL under budget is still reported (OR-COMPACT-1 part 3)', () => {
    notePassOutcome('a4', true, won, facts('summariser_refused', 12264));
    expect(reported.map((r) => r.stage)).toEqual(['summariser_refused']);
  });
});
