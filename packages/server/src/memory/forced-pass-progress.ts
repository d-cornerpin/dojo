// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 2 — A FORCED PASS ALWAYS RECORDS WHAT IT DID, AND ALWAYS HAS A NEXT STEP.
//
// An over-budget assembly whose instructions and tools fit is parked until its forced condense lands,
// then re-assembled once (`agent/v2/over-budget-assembly.ts`). The park's wake waits only while the
// compaction brake is armed (`full-context-wait.ts`), so a pass that made no progress AND armed no
// brake woke the agent at once into the same refusal, for ever: the t168 "1,216 wakes" class. The
// orchestrator's ruling — the assembly must CONVERGE, never loop and never surrender:
//
//   1. EVERY EXIT RECORDS ITS OUTCOME. A forced pass that found nothing to fold, or threw, goes through
//      `notePassOutcome` like every other pass, so a pass that bought nothing arms the brake and the
//      park waits for it. (A pass skipped because another holds the agent's lock does not exist for
//      the boundary's condense: it waits for the running pass, `assembly-validation.ts`.)
//   2. NOTHING LEFT OUTSIDE THE PROTECTED RECENT PART IS NOT THE END. The next forced pass folds the
//      OLDEST whole group of the protected part itself — summarised, never dropped: the live
//      conversation is kept as a summary — one group per pass, until the assembly fits. Every round
//      makes measurable progress, so the loop ends. A row too big for every summary writer is covered
//      by the existing stranded-row note (`coverRowsStrandedBelowBoundary`), and a long tool result
//      is already a pointer to its kept whole (t200), so a single row cannot stall the walk either.
//   3. A THROW IS A REAL FAILURE: logged, the brake arms, and if the pass throws again once the brake
//      has let go, the owner is told ONCE through the existing compaction card (`compaction-defect.ts`,
//      stage `summariser_threw`) — not an injury, not the Healer's "stuck" text.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getMessagesOutsideFreshTail } from './store.js';
import { getCompactedMessageIds } from './dag.js';
import { groupTail } from './assembler.js';
import { notePassOutcome, FORCED_YIELD_FLOOR_TOKENS } from './compaction-brakes.js';

const logger = createLogger('forced-pass-progress');

interface PassResult { leafCreated: number; condensedCreated: number; tokensReclaimed: number }

const progressed = (r: PassResult): boolean => r.leafCreated + r.condensedCreated > 0 || r.tokensReclaimed >= FORCED_YIELD_FLOOR_TOKENS;

/** Agents whose last forced pass threw, so a second throw (after the brake's bound) is the one the owner hears of. */
const threw = new Set<string>();

/** Run one forced pass, recording a throw as its outcome (ruling 3). The throw still reaches the caller. */
export async function recordingForcedPass(agentId: string, run: () => Promise<PassResult>): Promise<PassResult> {
  try {
    const result = await run();
    if (progressed(result)) threw.delete(agentId);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('a forced compaction pass threw', { error: detail }, agentId);
    const again = threw.has(agentId);
    threw.add(agentId);
    notePassOutcome(agentId, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 },
      again ? { stage: 'summariser_threw', detail } : undefined);
    throw err;
  }
}

/**
 * Ruling 2: a boundary refusal's forced pass (`untilItFits`) whose condensation bought nothing, with nothing
 * left to fold outside the protected recent part, folds the OLDEST whole exchange of that part — never the
 * newest group, which is what the agent is answering. `fold(throughSeq)` is the compactor's own leaf fold
 * (archive first); the combined outcome is recorded, so a fold that wrote nothing arms the brake.
 */
export async function foldOldestProtectedGroup(args: {
  agentId: string; protectedFromSeq: number; condensed: PassResult;
  fold: (throughSeq: number) => Promise<number>;
}): Promise<PassResult> {
  const { agentId, protectedFromSeq, condensed } = args;
  if (progressed(condensed)) return condensed;   // the pass made progress: the next round re-measures
  const compacted = getCompactedMessageIds(agentId);
  const live = getMessagesOutsideFreshTail(agentId, 1).filter((m) => !compacted.has(m.id) && (m.rowid ?? 0) >= protectedFromSeq);
  // The oldest WHOLE EXCHANGE: the first group and every group after it up to the next row the person
  // (or a peer) sent. The trim's atoms are rows, but a view must open on a user row, so folding a lone
  // ask leaves its answer at the head, where the integrity pass drops it from view — a round that
  // changed nothing (measured: every other round identical when the fold took one atom).
  const groups = groupTail(live);
  let end = 0;
  while (end + 1 < groups.length && groups[end + 1].messages[0].role !== 'user') end++;
  const oldest = groups.length > 1 ? groups.slice(0, end + 1).flatMap((g) => g.messages) : [];
  const throughSeq = oldest.length > 0 ? oldest[oldest.length - 1].rowid ?? 0 : 0;
  const leafCreated = throughSeq > 0 ? await args.fold(throughSeq) : 0;
  const result: PassResult = { leafCreated, condensedCreated: condensed.condensedCreated, tokensReclaimed: condensed.tokensReclaimed };
  logger.info('forced pass: nothing outside the protected recent part; folded its oldest group', { throughSeq, leafCreated, groupsLeft: groups.length - 1 }, agentId);
  notePassOutcome(agentId, true, result);
  return result;
}

/** Test-only reset; the set is per-process. */
export function __resetForcedPassProgressForTests(): void {
  threw.clear();
}
