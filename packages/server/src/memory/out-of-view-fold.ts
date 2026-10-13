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
//     folds AS MUCH AS IS LEAVING. The turn's Stop ends it at once. The per-agent compaction lock is
//     waited for only within that patience (a routine background holder is set aside first).
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
import { resolveStreamPatience } from '../agent/stream-patience.js';
import { owedThrough, preemptBackgroundCompaction, writeUncondensedPlaceholders } from './uncondensed-placeholder.js';
import { reportCompactionDefect } from './compaction-defect.js';
import { registerAbortable, releaseAbortable } from '../agent/shared-state.js';

const logger = createLogger('memory-out-of-view-fold');

/** Recursion bound: each pass covers everything the last assembly cut. A backstop, not a limit: a
 *  fold that has not converged after this many passes is a defect (logged), and placeholders cover. */
const OUT_OF_VIEW_FOLD_PASSES = 4;

/**
 * THE TURN'S PATIENCE, in ms: how long the owner already lets the model this turn dials take to
 * start answering — its provider's declared first-chunk patience, or the transport's standing one
 * (an auto-routed turn's assembly, before the router names its pick, gets the standing one).
 */
function turnPatienceMs(agentId: string, dialedModelId?: string): number {
  try {
    const db = getDb();
    const modelId = dialedModelId ?? (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
    const row = modelId ? db.prepare(
      'SELECT p.first_chunk_timeout_ms AS ms FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?',
    ).get(modelId) as { ms: number | null } | undefined : undefined;
    return resolveStreamPatience({ firstChunkTimeoutMs: row?.ms ?? null, streamIdleTimeoutMs: null }).firstChunkMs;
  } catch {
    return resolveStreamPatience(null).firstChunkMs;
  }
}

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
 * placeholders — all UNDER the compaction lock (round 4, re-review 3 F1). A routine background
 * compaction holding the lock is set aside first, and the door waits for it to step out. Only a
 * holder that will not yield (a manual or recovery compaction) can keep the lock past the turn's
 * patience; then, rather than dial a turn with rows nobody represents, the synchronous placeholder
 * write lands outside it — safe, because a real summary landing later takes its rows out of the
 * note (`uncondensed-head.ts`).
 */
async function foldOutOfView(agentId: string, contextWindow: number, throughSeq: number, budget: TurnBudget): Promise<void> {
  const bound = boundedSignal(budget.deadline, budget.stop);
  let failedWriter: string | null = null;
  let noWriter = false;
  let covered = 0;
  let started = false;
  let gaveUp = false;
  const setAside = preemptBackgroundCompaction(agentId);
  try {
    const locked = withLock(`compact:${agentId}`, async () => {
      if (gaveUp) return;   // the turn already covered these rows and moved on
      started = true;
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
    }, { ifBusy: 'wait' });
    const finished = locked.then(() => 'done' as const, (err: unknown) => {
      logger.error('The out-of-view fold failed; placeholders cover its rows', { error: err instanceof Error ? err.message : String(err) }, agentId);
      return 'done' as const;
    });
    const outOfTime = new Promise<'out-of-time'>((resolve) => {
      if (bound.signal.aborted) resolve('out-of-time');
      else bound.signal.addEventListener('abort', () => resolve('out-of-time'), { once: true });
    });
    let outcome: 'done' | 'out-of-time' = await Promise.race([finished, outOfTime]);
    // Our own fold holds the lock and is aborting: it only has its placeholders left to write. A
    // routine holder we set aside is stepping out — unless the owner stopped the turn.
    if (outcome === 'out-of-time' && (started || (setAside && budget.stop?.aborted !== true))) outcome = await finished;
    if (outcome !== 'done' && !started) {
      gaveUp = true;
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      logger.warn('The compaction lock was held past the turn\'s patience by a compaction that would not yield; placeholders were written beside it', {
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
