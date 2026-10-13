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
// it can FAIL WELL:
//   · ONE wall clock for the whole door (`OUT_OF_VIEW_FOLD_WALL_CLOCK_MS`, below) and a per-writer
//     slice of it, a cap of leaf chunks per turn, and the turn's Stop signal. The per-agent
//     compaction lock is waited for only until that clock, and the work done under it is aborted
//     at that clock — so the door never holds the lock past its own limit.
//   · A WRITER FALLBACK: a writer that times out, answers empty or errors (402 included) is passed
//     over for the next eligible one (`summary-writer-health.ts`).
//   · Whatever is still owed when the clock, the cap, Stop or the writers run out is covered by a
//     PLACEHOLDER (`uncondensed-placeholder.ts`) — model-free, so it always lands — and replaced
//     by a real summary in the background once a writer answers.
//   · LOUD, once: placeholders written because writers FAILED raise the compaction-failing card,
//     once per incident (`compaction-defect.ts`'s per-outage note). A capped backlog or a Stop is
//     not a failure and cards nothing.
//   · The 15-minute low-yield brake neither blocks this fold nor is armed by it (`leavingViewPass`).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { leavingViewPass } from './compaction.js';
import { abortBlamesWriter, eligibleSummaryWriters, summaryWriterCandidates, FOLD_IN_TURN_LIMIT, FOLD_STOPPED_BY_OWNER } from './summary-writer-health.js';
import { owedThrough, preemptBackgroundCompaction, writeUncondensedPlaceholders } from './uncondensed-placeholder.js';
import { reportCompactionDefect } from './compaction-defect.js';
import { registerAbortable, releaseAbortable } from '../agent/shared-state.js';

const logger = createLogger('memory-out-of-view-fold');

/**
 * THE DOOR'S OWN CLOCK: 30 s for everything it does in one turn. Chosen against the transport's
 * 90 s first-chunk bound: the owner's turn already waits up to that long for its OWN model, and a
 * fold that sits ahead of that call may cost a fraction of it, not a second one. An out-of-view span
 * is one or two leaf chunks; a healthy cloud writer returns a 5K-token summary of one well inside
 * this. A slower writer (a local model prefilling 30K tokens) does not lose anything by missing it:
 * its rows get a placeholder now and a real summary from the background replacement, which has the
 * routine condense's three minutes.
 */
export const OUT_OF_VIEW_FOLD_WALL_CLOCK_MS = 30_000;
/** One writer's slice of that clock: a hung writer leaves room for the next one to answer. */
export const OUT_OF_VIEW_FOLD_PER_WRITER_MS = 15_000;
/** Leaf chunks one turn may summarise in place. A backlog beyond it is placeholders + background. */
export const OUT_OF_VIEW_FOLD_MAX_CHUNKS = 2;
/** Recursion bound: each pass covers everything the last assembly cut. */
const OUT_OF_VIEW_FOLD_PASSES = 4;
/** Writers one turn may try. */
const OUT_OF_VIEW_FOLD_WRITER_TRIES = 3;

let bounds = { wallClockMs: OUT_OF_VIEW_FOLD_WALL_CLOCK_MS, perWriterMs: OUT_OF_VIEW_FOLD_PER_WRITER_MS };
/** Test-only: shorter clocks, so a clause measures the bound and not the default. */
export function __setOutOfViewFoldBoundsForTests(b: { wallClockMs: number; perWriterMs: number } | null): void {
  bounds = b ?? { wallClockMs: OUT_OF_VIEW_FOLD_WALL_CLOCK_MS, perWriterMs: OUT_OF_VIEW_FOLD_PER_WRITER_MS };
}

interface TurnBudget { deadline: number; chunks: number; stop?: AbortSignal; tried: Set<string> }

/** After the clock, how long the door still waits for a lock its own fold holds (that fold is
 *  aborting and only has its placeholders left to write), or for a holder it asked to yield. */
const LOCK_GRACE_MS = 1_000;

/** An abort that fires at `deadline` (the in-turn limit) or on Stop, carrying which one it was. */
function boundedSignal(deadline: number, stop?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const onStop = (): void => ctl.abort(FOLD_STOPPED_BY_OWNER);
  if (stop?.aborted) onStop(); else stop?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => ctl.abort(FOLD_IN_TURN_LIMIT), Math.max(0, deadline - Date.now()));
  (timer as unknown as { unref?: () => void }).unref?.();
  return { signal: ctl.signal, done: () => { clearTimeout(timer); stop?.removeEventListener('abort', onStop); } };
}

const sleep = (ms: number): Promise<'grace-over'> => new Promise((r) => { const t = setTimeout(() => r('grace-over'), ms); (t as unknown as { unref?: () => void }).unref?.(); });

/**
 * THE ENGINE'S ASSEMBLY DOOR. `assemble` is the one assembly this turn will dial (the assemble
 * step's, or a re-fit's for a smaller pick); `contextWindow` is that assembly's window; `abortSignal`
 * is the turn's Stop. Returns an assembly in which every row out of view is represented in view.
 */
export async function assembleWithNothingOutOfViewUnsummarised<T extends { outOfViewThroughSeq?: number }>(
  agentId: string, contextWindow: number, assemble: () => Promise<T>, opts: { abortSignal?: AbortSignal } = {},
): Promise<T> {
  // THE OWNER'S STOP reaches the fold through the same registry every model call uses (T83): a
  // stop cuts this controller with the calls it covers. A caller's own signal is folded in.
  const stop = new AbortController();
  registerAbortable(agentId, stop, 'turn');
  const onCaller = (): void => stop.abort();
  if (opts.abortSignal?.aborted) onCaller(); else opts.abortSignal?.addEventListener('abort', onCaller, { once: true });
  const budget: TurnBudget = { deadline: Date.now() + bounds.wallClockMs, chunks: OUT_OF_VIEW_FOLD_MAX_CHUNKS, stop: stop.signal, tried: new Set() };
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
      budget.chunks = 0;   // placeholders only — through the same locked path
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
 * Fold what is owed through `throughSeq` within the turn's budget, and cover the rest with
 * placeholders — all UNDER the compaction lock (round 4, re-review 3 F1). A routine background
 * compaction holding the lock is set aside first. Only a holder that will not yield (a manual or
 * recovery compaction) can keep the lock past the clock and a short grace; then, rather than dial a
 * turn with rows nobody represents, the synchronous placeholder write lands outside it — safe,
 * because a real summary landing later takes its rows out of the note (`uncondensed-head.ts`).
 */
async function foldOutOfView(agentId: string, contextWindow: number, throughSeq: number, budget: TurnBudget): Promise<void> {
  const bound = boundedSignal(budget.deadline, budget.stop);
  let failedWriter: string | null = null;
  let noWriter = false;
  let covered = 0;
  let started = false;
  let gaveUp = false;
  preemptBackgroundCompaction(agentId);
  try {
    const locked = withLock(`compact:${agentId}`, async () => {
      if (gaveUp) return;   // the turn already covered these rows and moved on
      started = true;
      for (let tries = 0; tries < OUT_OF_VIEW_FOLD_WRITER_TRIES; tries++) {
        if (bound.signal.aborted || budget.chunks <= 0) break;
        const owed = owedThrough(agentId, throughSeq).length;
        if (owed === 0) break;
        const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as
          { model_id: string | null } | undefined)?.model_id ?? undefined;
        const eligible = eligibleSummaryWriters(configured);
        if (eligible.length === 0) { noWriter = true; break; }
        // One try per writer per turn: a writer the in-turn slice cut is not failing — it is simply
        // not retried in THIS turn, and the background replacement gives it the longer bound.
        const writer = eligible.find((w) => !budget.tried.has(w));
        if (!writer) break;
        budget.tried.add(writer);
        // This writer's slice of the clock, ended early by the door's own bound or Stop.
        const slice = new AbortController();
        const onBound = (): void => slice.abort(bound.signal.reason);
        if (bound.signal.aborted) onBound(); else bound.signal.addEventListener('abort', onBound, { once: true });
        const sliceTimer = setTimeout(() => slice.abort(FOLD_IN_TURN_LIMIT),
          Math.max(0, Math.min(budget.deadline, Date.now() + bounds.perWriterMs) - Date.now()));
        try {
          const r = await leavingViewPass(agentId, writer, contextWindow,
            { cause: 'out-of-view', throughSeq, rowsLeaving: owed },
            { maxChunksPerRun: budget.chunks, abortSignal: slice.signal });
          budget.chunks -= r.leafCreated;
          if (r.leafCreated === 0 && abortBlamesWriter(slice.signal)) failedWriter = writer;
        } finally {
          clearTimeout(sliceTimer);
          bound.signal.removeEventListener('abort', onBound);
        }
      }
      // Still under the lock: whatever is owed is represented now — model-free, so this always lands.
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
    }, { ifBusy: 'wait' });
    const finished = locked.then(() => 'done' as const, (err: unknown) => {
      logger.error('The out-of-view fold failed; placeholders cover its rows', { error: err instanceof Error ? err.message : String(err) }, agentId);
      return 'done' as const;
    });
    const outOfTime = new Promise<'out-of-time'>((resolve) => {
      if (bound.signal.aborted) resolve('out-of-time');
      else bound.signal.addEventListener('abort', () => resolve('out-of-time'), { once: true });
    });
    let outcome: 'done' | 'out-of-time' | 'grace-over' = await Promise.race([finished, outOfTime]);
    // Our own fold holds the lock and is aborting: it only has its placeholders left to write. A
    // holder we asked to yield gets the same short grace — unless the owner stopped the turn.
    if (outcome === 'out-of-time' && (started || budget.stop?.aborted !== true)) outcome = await Promise.race([finished, sleep(LOCK_GRACE_MS)]);
    if (outcome !== 'done' && !started) {
      gaveUp = true;
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      logger.warn('The compaction lock was held past the out-of-view fold\'s clock by a compaction that would not yield; placeholders were written beside it', {
        throughSeq, covered,
      }, agentId);
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
