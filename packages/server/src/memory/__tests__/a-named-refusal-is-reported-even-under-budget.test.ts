// OR-COMPACT-1 part 3: a pass that ends on a named refusal (the writer refused, threw, or is unavailable) is a
// defect to repair, reported even when the view ended under budget.
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

describe('a named refusal is reported even under budget', () => {
  beforeEach(() => { reported.length = 0; __resetBrakesForTests(); });

  it('a named REFUSAL under budget is still reported (OR-COMPACT-1 part 3)', () => {
    notePassOutcome('a4', true, won, facts('summariser_refused', 12264));
    expect(reported.map((r) => r.stage)).toEqual(['summariser_refused']);
  });
});
