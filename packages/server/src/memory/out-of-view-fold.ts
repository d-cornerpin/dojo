// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — NO ROW IS EVER OUT OF VIEW WITHOUT SOMETHING IN VIEW STANDING FOR IT.
//
// Round 2 (re-review C1). The routine gate's folds are PRESSURE folds: ahead of need, in the
// background, whole trim blocks above the newest-row floor. On a small window one large row makes
// the token trim cut THIS assembly — floor rows included — and nothing started earlier can know
// which rows. So the assembly the turn dials is checked against itself: the assembler reports the
// newest seq it took out of view (`outOfViewThroughSeq`, read off the trim's own result), every
// unsummarised row at or below it is folded NOW, and the context is assembled again — which may cut
// again (the new summary costs room), so it recurses, bounded (OR-COMPACT-1).
//
// Round 3 (re-review 2, R-V333-10). That fold waits inside an owner's turn, so it is BOUNDED and
// it can FAIL WELL. Round 5 (owner ruling 2026-10-13, no hard limits) took this door's own numbers
// out — a 30 s clock, a 15 s slice per writer, two chunks and three writers per turn — because each
// one cut a writer that was answering, or left rows to placeholder notes a working writer could
// have summarised. What bounds it now is a real signal:
//   · THE TURN'S PATIENCE (`turnPatienceMs`): the fold sits in front of the turn's own model call,
//     so it may take as long as the owner already lets that model take to start answering — its
//     provider's declared first-chunk patience, or the transport's standing one. Inside it the door
//     folds AS MUCH AS IS LEAVING. The turn's Stop ends it at once. The turn never waits on the
//     per-agent compaction lock (round 6): if another compaction holds it, the rows are labelled now
//     and folded after.
//   · A WRITER FALLBACK: every eligible writer in turn (`summary-writer-health.ts`); one that
//     answers badly (empty, an error, 402) is passed over for the next. One that has not answered
//     when the patience runs out is not failing, but no later turn waits on it again until it has
//     answered (the background keeps trying it).
//   · Whatever is still owed when the patience, Stop or the writers run out is covered by a
//     PLACEHOLDER (`uncondensed-placeholder.ts`) — model-free, so it always lands — and replaced
//     by a real summary in the background, which has no clock, once a writer answers.
//   · LOUD, once: placeholders written because writers FAILED raise the compaction-failing card,
//     once per incident (`compaction-defect.ts`'s per-outage note). A capped backlog or a Stop is
//     not a failure and cards nothing.
//   · The 15-minute low-yield brake neither blocks this fold nor is armed by it (`leavingViewPass`).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { leavingViewPass } from './compaction.js';
import { abortBlamesWriter, eligibleSummaryWriters, noteDidNotAnswerInTurn, summaryWriterCandidates, FOLD_IN_TURN_LIMIT, FOLD_STOPPED_BY_OWNER } from './summary-writer-health.js';
import { turnPatienceMs } from './turn-patience.js';
import { owedThrough, preemptBackgroundCompaction, writeUncondensedPlaceholders } from './uncondensed-placeholder.js';
import { reportCompactionDefect } from './compaction-defect.js';
import { registerAbortable, releaseAbortable } from '../agent/shared-state.js';

const logger = createLogger('memory-out-of-view-fold');

/** Recursion bound: each pass covers everything the last assembly cut. A backstop, not a limit: a
 *  fold that has not converged after this many passes is a defect (logged), and placeholders cover. */
const OUT_OF_VIEW_FOLD_PASSES = 4;

interface TurnBudget { deadline: number; stop?: AbortSignal; tried: Set<string> }

/** An abort that fires at `deadline` (the in-turn limit) or on Stop, carrying which one it was. */
function boundedSignal(deadline: number, stop?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const onStop = (): void => ctl.abort(FOLD_STOPPED_BY_OWNER);
  if (stop?.aborted) onStop(); else stop?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => ctl.abort(FOLD_IN_TURN_LIMIT), Math.max(0, deadline - Date.now()));
  (timer as unknown as { unref?: () => void }).unref?.();
  return { signal: ctl.signal, done: () => { clearTimeout(timer); stop?.removeEventListener('abort', onStop); } };
}

/**
 * THE ENGINE'S ASSEMBLY DOOR. `assemble` is the one assembly this turn will dial (the assemble
 * step's, or a re-fit's for a smaller pick); `contextWindow` is that assembly's window; `abortSignal`
 * is the turn's Stop; `dialedModelId` the pick when the caller knows it (its patience bounds the
 * fold; absent, the agent's configured model's). Returns an assembly in which every row out of view
 * is represented in view.
 */
export async function assembleWithNothingOutOfViewUnsummarised<T extends { outOfViewThroughSeq?: number }>(
  agentId: string, contextWindow: number, assemble: () => Promise<T>, opts: { abortSignal?: AbortSignal; dialedModelId?: string } = {},
): Promise<T> {
  // THE OWNER'S STOP reaches the fold through the same registry every model call uses (T83): a
  // stop cuts this controller with the calls it covers. A caller's own signal is folded in.
  const stop = new AbortController();
  registerAbortable(agentId, stop, 'turn');
  const onCaller = (): void => stop.abort();
  if (opts.abortSignal?.aborted) onCaller(); else opts.abortSignal?.addEventListener('abort', onCaller, { once: true });
  const budget: TurnBudget = { deadline: Date.now() + turnPatienceMs(agentId, opts.dialedModelId), stop: stop.signal, tried: new Set() };
  try {
    let assembled = await assemble();
    for (let pass = 0; pass < OUT_OF_VIEW_FOLD_PASSES; pass++) {
      const throughSeq = assembled.outOfViewThroughSeq ?? 0;
      if (throughSeq <= 0 || owedThrough(agentId, throughSeq).length === 0) return assembled;
      await foldOutOfView(agentId, contextWindow, throughSeq, budget);
      assembled = await assemble();
    }
    const throughSeq = assembled.outOfViewThroughSeq ?? 0;
    if (throughSeq > 0 && owedThrough(agentId, throughSeq).length > 0) {
      logger.error('DEFECT: the out-of-view fold did not converge within its passes; placeholders cover the rest', {
        passes: OUT_OF_VIEW_FOLD_PASSES, throughSeq,
      }, agentId);
      budget.deadline = Date.now();   // placeholders only — through the same locked path
      await foldOutOfView(agentId, contextWindow, throughSeq, budget);
      assembled = await assemble();
    }
    return assembled;
  } finally {
    opts.abortSignal?.removeEventListener('abort', onCaller);
    releaseAbortable(agentId, stop);
  }
}

/**
 * Fold what is owed through `throughSeq` within the turn's patience, and cover the rest with
 * placeholders — UNDER the compaction lock when the turn gets it (round 4, re-review 3 F1). A routine
 * background compaction is set aside first. Round 6 (final review I2, R-V333-15): A TURN NEVER WAITS
 * ON ANOTHER COMPACTION'S LOCK. If anyone holds it — a manual or recovery compaction, or background
 * work that has not stepped out yet — the rows are labelled by placeholder notes now, beside the
 * lock, and the real fold happens after, in the background. That is safe because a real summary
 * landing later takes its rows out of the note (`uncondensed-head.ts`).
 */
async function foldOutOfView(agentId: string, contextWindow: number, throughSeq: number, budget: TurnBudget): Promise<void> {
  const bound = boundedSignal(budget.deadline, budget.stop);
  let failedWriter: string | null = null;
  let noWriter = false;
  let covered = 0;
  preemptBackgroundCompaction(agentId);
  try {
    const ran = await withLock(`compact:${agentId}`, async () => {
      while (!bound.signal.aborted) {
        const owed = owedThrough(agentId, throughSeq).length;
        if (owed === 0) break;
        const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as
          { model_id: string | null } | undefined)?.model_id ?? undefined;
        const eligible = eligibleSummaryWriters(configured);
        if (eligible.length === 0) { noWriter = true; break; }
        // Each eligible writer once per turn — the list is the bound, not a count of tries.
        const writer = eligible.find((w) => !budget.tried.has(w));
        if (!writer) break;
        budget.tried.add(writer);
        // As much as is leaving, ended only by the turn's patience, Stop, or the writer's transport.
        const r = await leavingViewPass(agentId, writer, contextWindow,
          { cause: 'out-of-view', throughSeq, rowsLeaving: owed }, { abortSignal: bound.signal });
        if (r.leafCreated === 0 && bound.signal.reason === FOLD_IN_TURN_LIMIT) noteDidNotAnswerInTurn(writer);
        else if (r.leafCreated === 0 && abortBlamesWriter(bound.signal)) failedWriter = writer;
      }
      // Still under the lock: whatever is owed is represented now — model-free, so this always lands.
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      return true;
    }, { ifBusy: 'skip' }).catch((err: unknown) => {
      logger.error('The out-of-view fold failed; placeholders cover its rows', { error: err instanceof Error ? err.message : String(err) }, agentId);
      return false;
    });
    if (ran !== true) {
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      if (ran === undefined) {
        logger.info('Another compaction holds the lock: the turn labels the rows leaving view and the fold happens after', {
          throughSeq, covered,
        }, agentId);
      }
    }
  } finally {
    bound.done();
  }

  const stopped = budget.stop?.aborted === true;
  if (covered > 0 && !stopped && (failedWriter !== null || noWriter)) {
    const none = noWriter && summaryWriterCandidates().length === 0;
    reportCompactionDefect(agentId, none ? 'summary_writer_unresolvable' : 'summary_writer_unavailable', {
      modelId: failedWriter ?? undefined,
      detail: `${covered} row(s) left the live view while no summary writer answered; placeholder notes stand in for them`,
    }, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
  }
}
