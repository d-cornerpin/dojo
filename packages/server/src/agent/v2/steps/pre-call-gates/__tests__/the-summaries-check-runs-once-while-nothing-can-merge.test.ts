// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix 3 (#12): THE SUMMARIES-DROPPED CHECK RUNS ONCE WHILE NOTHING CAN MERGE.
//
// Field report 3, Problem 5b: on a long-lived agent the view's summaries lane holds less than the
// summaries it owns ("summaries=2054 of 11809"), and that can stay true for ever. On every tool
// round the routine check started a background `checkAndCompact` for it, which resolved the
// summary writer, measured a second dry-run assembly and logged a "Compaction check", only for
// the condensation pass to find, by its own measure, that it could not help (fewer than two notes
// of one depth to merge). Ten tool rounds, ten checks.
//
// The fix keys on a real signal, not a clock: the pass says it cannot help (`cannotHelp`), and the
// gate does not ask again until the summaries it measured change (a new note, a merge, a changed
// raw size) or a person speaks (which earns the writers a retry).
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cannot = async () => ({ leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0, cannotHelp: true as const });
const checkAndCompactSpy = vi.fn(cannot);
const summaries = vi.hoisted(() => ({ count: 40, raw: 11_809 }));
const gauge = () => ({
  total: 60_000, summaryTokens: 2_054, freshTailTokens: 50_000, freshTailCount: 30, summaryCount: summaries.count, reserveTokens: 0,
  view: {
    budgetTokens: 125_000, tailRoomTokens: 60_000, reserveTokens: 0, systemTokens: 8_000, summaryTokens: 2_054, summaryRawTokens: summaries.raw,
    summaryCount: summaries.count, tailTokens: 50_000, tailKeptTokens: 50_000, tailKeptRows: 30, outOfViewThroughSeq: 0,
    leavingThroughSeq: 0, leavingRows: 0, leavingTokens: 0, protectedFromSeq: 1,
  },
});
const estimateAssembledTokensSpy = vi.fn(async () => gauge());
vi.mock('../../../../../memory/compaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/compaction.js')>()),
  checkAndCompact: (...a: unknown[]) => checkAndCompactSpy(...(a as [])),
  estimateAssembledTokens: (...a: unknown[]) => estimateAssembledTokensSpy(...(a as [])),
}));
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => { throw new Error('no database in this unit test'); } }));

import { condenseForTheDialedModel } from '../context-gates.js';
import { backgroundDrains } from '../../../../shared-state.js';

const AGENT = 'agent-summaries-dropped';
const round = async (opts: { aPersonSpoke?: boolean } = {}): Promise<void> => {
  await condenseForTheDialedModel({ agentId: AGENT, dialedModelId: 'm', contextWindow: 1_000_000, writerModelId: 'm', aPersonSpoke: opts.aPersonSpoke });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));   // the background drain lands and frees its slot
};

beforeEach(() => {
  checkAndCompactSpy.mockReset();
  checkAndCompactSpy.mockImplementation(cannot);
  estimateAssembledTokensSpy.mockClear();
  backgroundDrains.delete(AGENT);
  summaries.count += 1;   // a fresh summary set per clause, so no clause inherits another's answer
  summaries.raw += 1;
});

describe('summaries dropped, nothing can merge', () => {
  it('over 10 tool rounds there is ONE check, not 10', async () => {
    for (let i = 0; i < 10; i++) await round();
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);
  });

  it('a new summary is a change: the check runs again', async () => {
    await round();
    await round();
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(1);
    summaries.count += 1;
    summaries.raw += 300;
    await round();
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(2);
  });

  it('a person speaking is a change (the writers earn a retry): the check runs again', async () => {
    await round();
    await round();
    await round({ aPersonSpoke: true });
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a pass that could help (no cannotHelp) is asked again on the next round', async () => {
    checkAndCompactSpy.mockImplementation(async () => ({ leafCreated: 0, condensedCreated: 1, tokensReclaimed: 400 }) as never);
    await round();
    await round();
    expect(checkAndCompactSpy).toHaveBeenCalledTimes(2);
  });
});
