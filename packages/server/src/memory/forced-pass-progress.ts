// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 D18 fix round 2 — A FORCED PASS ALWAYS RECORDS WHAT IT DID, AND ALWAYS HAS A NEXT STEP.
//
// An over-budget assembly whose instructions and tools fit is parked until its forced condense lands,
// then re-assembled once (`agent/v2/over-budget-assembly.ts`). The park's wake waits only while the
// compaction brake is armed (`full-context-wait.ts`), so a pass that made no progress AND armed no
// brake woke the agent at once into the same refusal, for ever: the t168 "1,216 wakes" class. The
// orchestrator's ruling — the assembly must CONVERGE, never loop and never surrender:
//
//   1. EVERY EXIT RECORDS ITS OUTCOME, STRUCTURALLY (fix round 3). `checkAndCompact` runs every forced
//      pass through `recordingForcedPass`, so no caller has to remember: a return path that recorded
//      nothing (the leaf-less early return, say, reached by the recovery door) is recorded here, WITH
//      its facts, so a pass that bought nothing arms the brake and the park waits for it, and a genuine
//      stall (over budget with nothing left that can shrink) is reported once as a compaction defect.
//      Fix rounds 4-5: A BUSY LOCK IS HANDLED HERE TOO, for every caller (`forcedPassDoor`): a turn's pass is
//      told the lock is busy and its caller parks until the running pass lands; the owner's waits for it.
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
import { notePassOutcome, compactionBrakeMsLeft, FORCED_YIELD_FLOOR_TOKENS } from './compaction-brakes.js';
import { isStopFenced } from '../agent/shared-state.js';
import { withLock } from '../db/with-lock.js';

const logger = createLogger('forced-pass-progress');

interface PassResult { leafCreated: number; condensedCreated: number; tokensReclaimed: number }

const progressed = (r: PassResult): boolean => r.leafCreated + r.condensedCreated > 0 || r.tokensReclaimed >= FORCED_YIELD_FLOOR_TOKENS;

/** Agents whose last forced pass that RAN threw, so a second throw (after the brake's bound) is the one the owner
 *  hears of. Per pass (fix round 4): any pass that runs and returns clears it, so a throw never silences a later
 *  stall; a braked skip did not run, so it leaves it as it was. */
const threw = new Set<string>();

/** Did this agent's last forced pass that ran throw? (Its park is then told through the compaction card, never "stuck".) */
export const lastForcedPassThrew = (agentId: string): boolean => threw.has(agentId);

/** Was this agent's last forced pass skipped by the brake (rather than run)? Read by a park that awaited it. */
const skippedByBrake = new Map<string, boolean>();
export const lastForcedPassWasBraked = (agentId: string): boolean | undefined => skippedByBrake.get(agentId);

/**
 * Run one forced pass and RECORD ITS OUTCOME ON EVERY RETURN PATH (rulings 1 and 3). A path that already
 * recorded (it ran and noted, or the brake skipped it) is left alone; one that recorded nothing is noted
 * here with the pass's measured facts. A throw is recorded too, and still reaches the caller.
 */
export async function recordingForcedPass(agentId: string, run: () => Promise<PassResult>, opts: {
  abortSignal?: AbortSignal; measure: () => Promise<{ assembledTokens: number; budgetTokens: number }>;
}): Promise<PassResult> {
  const brakedBefore = compactionBrakeMsLeft(agentId) !== null;   // a braked skip IS the recorded outcome
  skippedByBrake.set(agentId, brakedBefore);
  try {
    const result = await run();
    if (!brakedBefore) threw.delete(agentId);   // this pass ran and returned: whatever came before, it did not throw
    if (progressed(result)) return result;
    if (!brakedBefore && compactionBrakeMsLeft(agentId) === null && !opts.abortSignal?.aborted && !isStopFenced(agentId)) {
      const facts = await opts.measure().catch(() => undefined);
      const stalled = facts !== undefined && facts.assembledTokens > facts.budgetTokens;
      logger.warn('a forced pass returned without recording what it bought; recorded now', { ...facts, stalled }, agentId);
      notePassOutcome(agentId, true, result, { ...facts, stage: stalled ? 'nothing_left_to_shrink' : null });
    }
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

/** Every pass that finished under an agent's compaction lock: how many, and what the last one bought. */
const finished = new Map<string, { count: number; last: PassResult }>();

/** Run `run` (already holding the agent's lock) and count it as a pass that finished under the lock. */
export async function finishedUnderTheLock<T extends PassResult>(agentId: string, run: () => Promise<T>): Promise<T> {
  const result = await run();
  finished.set(agentId, { count: (finished.get(agentId)?.count ?? 0) + 1, last: result });
  return result;
}

/** How many passes have finished under this agent's lock (read before a forced pass queues for it). */
export const passesFinished = (agentId: string): number => finished.get(agentId)?.count ?? 0;

/**
 * Ruling 2 (fix round 4), inside the lock a forced pass waited for: the pass that was running when it queued
 * made progress, so the next assembly re-measures (its result is returned and nothing is dialed again); else
 * null, and the forced pass runs itself and records its own outcome.
 */
export function afterTheRunningPass(agentId: string, finishedWhenQueued: number): PassResult | null {
  const f = finished.get(agentId);
  return f && f.count > finishedWhenQueued && progressed(f.last) ? f.last : null;
}

/** What the door answers: the pass's counts, and when the lock was busy, which way that was settled. */
export type DoorResult = PassResult & { lockBusy?: true; byRunningPass?: boolean };

/**
 * THE ONE FORCED-PASS DOOR (`checkAndCompact` runs every forced pass through it). A busy lock is never skipped
 * silently (the skip recorded nothing and woke the agent at once into the same wall):
 *   · INSIDE A TURN (`inTurn`: the recovery door, the boundary's refusal) it never waits on another pass's lock
 *     (t140 r6/r7): it answers `lockBusy`, and the caller parks until that pass lands (`parkUntilCompactionLands`);
 *   · the owner's compact-now waits for the running pass, then runs its own unless that pass made progress and
 *     left the view fitting (fix round 5, ruling 4), and says which (`byRunningPass`).
 * A pass that runs records its outcome (`recordingForcedPass`).
 */
export async function forcedPassDoor(agentId: string, run: () => Promise<PassResult>, opts: Parameters<typeof recordingForcedPass>[2] & { inTurn?: boolean }): Promise<DoorResult> {
  const lock = `compact:${agentId}`;
  const own = (): Promise<PassResult> => finishedUnderTheLock(agentId, () => recordingForcedPass(agentId, run, opts));
  if (opts.inTurn) return (await withLock(lock, own, { ifBusy: 'skip' })) ?? { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0, lockBusy: true };
  const queuedAfter = passesFinished(agentId);
  const result = await withLock(lock, async (): Promise<DoorResult> => {
    const borrowed = afterTheRunningPass(agentId, queuedAfter);
    const facts = borrowed ? await opts.measure().catch(() => undefined) : undefined;
    if (borrowed && facts && facts.assembledTokens <= facts.budgetTokens) return { ...borrowed, byRunningPass: true };
    return borrowed ? { ...(await own()), byRunningPass: false } : own();   // said only when a running pass had progress
  }, { ifBusy: 'wait' });
  return result ?? { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };   // 'wait' always runs it: for the type only
}

/** Test-only reset; the sets are per-process. */
export function __resetForcedPassProgressForTests(): void {
  threw.clear();
  skippedByBrake.clear();
  finished.clear();
}
