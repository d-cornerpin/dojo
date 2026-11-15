import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { MIN_COMPACTABLE_ROWS, compactionDoor, compactionIsBraked, notePassOutcome, progressed,
  summaryWriterUnavailable } from './compaction-brakes.js';
import { condenseUntilFits, condensableSummaries, rawContextSummaryTokens, type CondensationOutcome } from './condense-until-fits.js';
import { cachedAssembledEstimate } from './assembled-estimate-cache.js';
export { forcedCompactionOptions } from './compaction-brakes.js';   // the emergency path's bounds, published where its callers already look
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getMessagesOutsideFreshTail, getRecentMessages } from './store.js';
import { rowsLeavingView, rowsStrandedBelowBoundary, type LeavingView } from './tail-horizon.js';
import { estimateTokens, getFreshTailCount, SystemPromptTooLargeError } from './budget.js';
import type { PromptTurnContext } from '../prompt/assembler.js';
import { insertMessageIfAbsent, retireReplayedReasoningBeforeTurn } from './message-store.js';
// The assembler declares and renders the stub distance, this module decides when it applies: one literal.
import { V2_STUB_AFTER_TURNS, groupTail, type ContextView } from './assembler.js';
import { summaryWriterCandidates, eligibleSummaryWriters, ownModel, pickWriter, summaryRoom, writerPassedOver, spanWaitsForAWriter, summaryCallStarts } from './writer.js';
import { ownerProgressFrame } from '../healer/owner-notices.js';
import { supersedeUncondensedPlaceholders } from './uncondensed-head.js';
import { createLeafSummary, getCompactedMessageIds, replaceContextItems } from './dag.js';
import { generateSummary } from './summarize.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { LEAF_CHUNK_TOKENS, fullSpanTargetTokens, leafKeepCap, summaryShare, summaryTargetTokens } from './summary-target.js';
import { authoredInputLines, fitInputToBudget, resultForSummary, resultText } from './summary-authored-text.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { archiveMessagesBeforeCompaction, isDreamerIgnored, getArchiveHighWaterMark } from '../vault/archive.js';
import { isSystemServiceAgent } from '../config/platform.js';
import { lastCompactionDividerAt, isStopFenced } from '../agent/shared-state.js';
import { summaryPartyTag } from './party-label.js';
import { groupBySubject, conversationLabels } from './summary-subject.js';
import { renderInstant } from './message-stamp.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { isPlatformNoise } from './platform-noise.js';
import type { Message } from '@dojo/shared';
import { formatDivider, A2A_INBOUND_RE, TECHNIQUE_FRESH_SENTINEL } from '@dojo/shared';

// Inbound peer A2A is inter-agent traffic, not the user's conversation: it is excluded from summary input
// through the assembler's own marker set (A2A_INBOUND_RE), so the two strips cannot disagree.

/** A row that must NOT be folded into a context summary: platform/inter-agent plumbing or an inbound peer
 *  A2A message. Also the filter the nightly rebuild (memory/summary-rebuild.ts) replays. */
export function isNonConversationForSummary(content: string | null | undefined): boolean {
  return isPlatformNoise(content) || (!!content && A2A_INBOUND_RE.test(content));
}

/** Placeholder stored for a span with no user conversation; shared with the nightly summary rebuild. */
export const NO_CONVERSATION_PLACEHOLDER = '(system/inter-agent activity, no user conversation in this span)';

// ── THE GAUGE: what the next model call will actually be sent ──
// The assembler's own dry run (`measureView`) is the one measure that the condense trigger, the pressure pass
// and condense-until-fits read.

/** Where the newest group starts: what the trim keeps whatever happens (a tool result with its call). */
function newestGroupSeq(agentId: string): number {
  const rows = getDb().prepare('SELECT seq, role FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT 2').all(agentId) as Array<{ seq: number; role: string }>;
  return rows[0]?.role === 'tool' && rows[1] ? rows[1].seq : rows[0]?.seq ?? 0;
}

const EMPTY_VIEW: ContextView = {
  budgetTokens: 0, tailRoomTokens: 0, reserveTokens: 0, systemTokens: 0, summaryTokens: 0, summaryRawTokens: 0, summaryCount: 0, tailTokens: 0,
  tailKeptTokens: 0, tailKeptRows: 0, outOfViewThroughSeq: 0, leavingThroughSeq: 0, leavingRows: 0, leavingTokens: 0, protectedFromSeq: 0,
};

/** The assembler's own dry run for `modelId` (default: the agent's configured model). `summaryTokens` and
 *  `freshTailTokens` are what the view ADMITS; `total` is what it WANTS to hold (summaries sent plus the live
 *  tail before the trim), so `total > view.budgetTokens` means the view is cutting the live conversation. */
export async function estimateAssembledTokens(
  agentId: string,
  contextWindow: number,
  modelId?: string,
  opts?: { turnContext?: PromptTurnContext },
): Promise<{
  total: number; summaryTokens: number; freshTailTokens: number; freshTailCount: number; summaryCount: number;
  reserveTokens: number; view: ContextView;
}> {
  const model = modelId ?? (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? '';
  const { measureView } = await import('./assembler.js');
  // A window that cannot hold the system prompt admits nothing: an empty view (see `window-starvation-card.ts`).
  const view = await measureView(agentId, model, { contextWindow, turnContext: opts?.turnContext }).catch((err: unknown) => {
    if (err instanceof SystemPromptTooLargeError) return { ...EMPTY_VIEW, summaryRawTokens: rawContextSummaryTokens(agentId), protectedFromSeq: newestGroupSeq(agentId) };
    throw err;
  });
  return {
    total: view.summaryTokens + view.tailTokens, summaryTokens: view.summaryTokens, freshTailTokens: view.tailKeptTokens,
    freshTailCount: view.tailKeptRows, summaryCount: view.summaryCount, reserveTokens: view.reserveTokens, view,
  };
}

/** The rows leaving the view, off the gauge: the trim's own cut (whole half-tail blocks). They leave whatever
 *  happens, so folding them first is owed. */
export function leavingFromView(view: ContextView): LeavingView | null {
  const full = view.leavingThroughSeq > 0 ? { throughSeq: view.leavingThroughSeq, rows: view.leavingRows } : null;
  return rowsLeavingView({ full });
}

/** When each agent last needed a FORCED pass. Every context-overflow door forces one, so a run that saw one
 *  failed on its window, not on the message it served (`runtime.ts`). */
const forcedPassAt = new Map<string, number>();
export function contextOverflowSince(agentId: string, sinceMs: number): boolean {
  return (forcedPassAt.get(agentId) ?? Number.NEGATIVE_INFINITY) >= sinceMs;
}

const logger = createLogger('memory-compaction');

// ── Technique-content scrub for summarization ──
// technique_read / use_technique results carry TECHNIQUE_FRESH_SENTINEL; they are stubbed before summarizing so
// the body never lands in a summary the agent would later read as authoritative.
const TECHNIQUE_SCRUB_STUB =
  '[technique read withheld from summary by engine policy, call technique_read for the current on-disk content; do not paraphrase from this summary]';

// Same risk class: credential_get prepends this sentinel to a raw secret; the engine stubs it deterministically
// so a persisted summary never rests on the summarizer model's discretion.
export const CREDENTIAL_FRESH_SENTINEL = '══ CREDENTIAL FRESH READ ══';
const CREDENTIAL_SCRUB_STUB =
  '[credential value withheld from summary by engine policy, call credential_get for the current value; never persist or paraphrase a secret]';

function scrubStubFor(content: string): string | null {
  if (content.startsWith(TECHNIQUE_FRESH_SENTINEL)) return TECHNIQUE_SCRUB_STUB;
  if (content.startsWith(CREDENTIAL_FRESH_SENTINEL)) return CREDENTIAL_SCRUB_STUB;
  return null;
}

export function scrubTechniqueContentForSummary(messageContent: string): string {
  const fast = scrubStubFor(messageContent);
  if (fast) return fast;
  try {
    const parsed = JSON.parse(messageContent);
    if (!Array.isArray(parsed)) return messageContent;
    let changed = false;
    const next = parsed.map((block: unknown) => {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== 'tool_result') return block;
      if (typeof b.content !== 'string') return block;
      const stub = scrubStubFor(b.content);
      if (!stub) return block;
      changed = true;
      return { ...b, content: stub };
    });
    return changed ? JSON.stringify(next) : messageContent;
  } catch {
    return messageContent;
  }
}

// ── Defaults: summary SHAPES, not budget ──

const DEFAULTS = {
  leafChunkTokens: LEAF_CHUNK_TOKENS,
  // The fanout is the batch SIZE, not a floor: `condense-until-fits.ts` condenses 2, 3 or even 1.
  condensedMinFanout: 4,
};

export function getLeafChunkTokens(): number {
  return DEFAULTS.leafChunkTokens;
}

/** The target of the largest leaf job (a full chunk, before its facts): what a chunk leaves room for. */
export function getLeafTargetTokens(): number {
  return fullSpanTargetTokens();
}


// Every row is summarised before it leaves the live view: `tail-horizon.ts`'s `rowsLeavingView` and the
// leaving-view pass below fold exactly the rows that are leaving, never ones the agent is still reading.

// ── Chat divider helpers ──

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K tokens`;
  return `${n} tokens`;
}

// Never auto-inject recalled thread content into the message log after a compaction: it grows the next tail and
// re-triggers compaction. recall_recent_thread stays a tool the agent calls on demand.

const COMPACTION_DIVIDER_THROTTLE_MS = 10 * 60 * 1000;

/** True when this agent's last divider is 10+ minutes old (no chat spam during a backlog drain). */
function shouldShowCompactionDivider(agentId: string): boolean {
  const last = lastCompactionDividerAt.get(agentId) ?? 0;
  return Date.now() - last >= COMPACTION_DIVIDER_THROTTLE_MS;
}

function insertCompactionDivider(agentId: string, opts: { label: string }): void {
  try {
    const id = uuidv4();
    const content = formatDivider(opts.label);
    const createdAt = new Date().toISOString();
    insertMessageIfAbsent({ id, agentId, role: 'system', content });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id,
        agentId,
        role: 'system' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt,
      },
    });
    lastCompactionDividerAt.set(agentId, Date.now());
  } catch (err) {
    logger.warn('Failed to insert compaction divider', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Wraps a compaction work call so the dashboard shows "Compacting memory" from its first summary model call
// (summarize.ts runs summaryCallStarts) until it ends; a pass that never calls the writer shows nothing.
async function withCompactionActivity<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  const id = `compaction_${agentId}_${Date.now()}`;
  let started = false;
  try {
    return await summaryCallStarts.run(() => { if (!started) ownerProgressFrame('start', id, agentId, 'Compacting memory'); started = true; }, work);
  } finally {
    if (started) ownerProgressFrame('end', id, agentId, 'Compacting memory');
  }
}


export interface CheckAndCompactOptions {
  force?: boolean;
  inTurn?: boolean;   // a turn's forced pass never waits on the lock; it is told (`lockBusy`) and parks
  untilItFits?: boolean;   // a boundary refusal's pass: with nothing else to fold, folds the protected part's oldest exchange
  // Optional abort signal: lets the background condense cancel a hung summarizer call.
  abortSignal?: AbortSignal;
  /** The rows the caller measured as leaving the live view; an unpressured call folds ONLY these. Absent, an
   *  unforced call asks the gauge (`leavingFromView`). */
  leaving?: LeavingView | null;
  /** The model this call's pressure was measured for (the box serving the turn); absent, `modelId`. Kept apart
   *  from `modelId`, the summary WRITER's preference (`pickWriter`). */
  dialedModelId?: string;
  /** A background fold: with no writer answering it dials nothing. */
  inTheBackground?: boolean;
}

/** `cannotHelp`: the condensation pass measured that it cannot help this summary set (all fit, or fewer than two
 *  notes of one depth can merge); the routine check holds off until the set changes (`context-gates.ts`). */
export type CompactionResult = { leafCreated: number; condensedCreated: number; tokensReclaimed: number; lockBusy?: true; byRunningPass?: boolean; cannotHelp?: true };

const NO_COMPACTION: CompactionResult = { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };

/**
 * The one site covering every compaction entry point, so the per-agent mutual exclusion lives here: an unforced
 * pass skips when busy, a forced one never silently (a turn's parks, the owner's waits: `compactionDoor`).
 * Skip, not wait: a queued pass would find nothing after holding the turn; callers treat zero as no work.
 * The lock is IN-PROCESS only.
 */
export async function checkAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const run = (): Promise<CompactionResult> => runCheckAndCompact(agentId, modelId, contextWindow, options);
  if (options?.force) {
    forcedPassAt.set(agentId, Date.now());
    return (await compactionDoor(agentId, run, { abortSignal: options.abortSignal, inTurn: options.inTurn, measure: async () => { const m = await measured(agentId, contextWindow, options.dialedModelId ?? modelId); return { assembledTokens: m.total, budgetTokens: m.view.budgetTokens }; } }))!;
  }
  const result = await compactionDoor(agentId, run);
  if (result === undefined) logger.info('Compaction skipped: another compaction is already running for this agent', {}, agentId);
  return result ?? NO_COMPACTION;
}

async function runCheckAndCompact(
  agentId: string,
  modelId: string,
  contextWindow: number,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  // The box serving the turn, captured before the writer resolution below reassigns `modelId`.
  const turnModelId = options?.dialedModelId ?? modelId;

  {
    const resolved = pickWriter(agentId, modelId);
    if (!resolved && (spanWaitsForAWriter(agentId) || options?.inTheBackground || summaryWriterCandidates(modelId, agentId).length > 0)) {   // the wait is recorded
      logger.info('No summary writer can run now: the span waits for one, rows whole', {}, agentId);
      if (options?.force) notePassOutcome(agentId, true, NO_COMPACTION, { stage: 'summary_writer_unavailable', modelId: summaryWriterCandidates(modelId, agentId)[0], waiting: true });   // told, never braked
      return NO_COMPACTION;
    }
    if (!resolved) {
      // Under pressure (`force` is the pressure signal) this is a repairable reason, not a shrug.
      // Not the brake: it returns before `compactionIsBraked`; see compaction-defect.
      if (options?.force) notePassOutcome(agentId, true, NO_COMPACTION, { stage: 'summary_writer_unresolvable', modelId: turnModelId });
      logger.warn('No text-capable model available for compaction, skipping', {}, agentId);
      return NO_COMPACTION;
    }
    modelId = resolved;
  }

  const assembled = await measured(agentId, contextWindow, turnModelId);
  const { view } = assembled;
  const totalTokens = assembled.total;
  const budget = view.budgetTokens;
  const force = options?.force ?? false;
  // THE TRIGGERS: forced (an overflow door or the owner's compact-now); rows leaving the view; the view dropping
  // summaries the agent holds (condensation's case). A STARVED window (it cannot hold the system prompt) admits
  // no summary whatever condensation does, so it is never condensation's case.
  const starved = view.budgetTokens === 0;
  const summariesDropped = !starved && view.summaryRawTokens > view.summaryTokens;
  const leaving = force ? null : options?.leaving !== undefined ? options.leaving : leavingFromView(view);
  const outsideProtected = (): Message[] => {
    const compacted = getCompactedMessageIds(agentId);
    return getMessagesOutsideFreshTail(agentId, 1).filter(m => !compacted.has(m.id) && (m.rowid ?? Infinity) < view.protectedFromSeq);
  };
  const uncompactedOutsideFloor = force ? outsideProtected().length : 0;

  logger.info(`Compaction check: view=${totalTokens} (summaries=${view.summaryTokens} of ${view.summaryRawTokens}, tail=${view.tailKeptTokens} of ${view.tailTokens}), budget=${budget}${leaving ? `, leaving=${leaving.rowsLeaving} rows (${leaving.cause}) through seq ${leaving.throughSeq}` : ''}${force ? ' [FORCED]' : ''}`, {
    assembledTokens: totalTokens, summaryTokens: view.summaryTokens, summaryRawTokens: view.summaryRawTokens,
    freshTailTokens: view.tailKeptTokens, liveTailTokens: view.tailTokens, freshTailCount: view.tailKeptRows,
    summaryCount: view.summaryCount, budgetTokens: budget, contextWindow, uncompactedOutsideFloor,
    protectedFromSeq: view.protectedFromSeq, leavingCause: leaving?.cause ?? null, leavingRows: leaving?.rowsLeaving ?? 0,
    leavingThroughSeq: leaving?.throughSeq ?? null, force,
  }, agentId);

  if (!force && leaving) {
    const folded = await leavingViewPass(agentId, modelId, contextWindow, leaving, options);
    if (leaving.cause === 'out-of-view' || compactionIsBraked(agentId, false)) return folded;
    const condensed = await condenseOnlyPass(agentId, modelId, turnModelId, contextWindow, budget, false, 0, options);
    return { ...folded, condensedCreated: condensed.condensedCreated, tokensReclaimed: condensed.tokensReclaimed };
  }
  if (!force && summariesDropped) {
    if (compactionIsBraked(agentId, false)) return NO_COMPACTION;
    return condenseOnlyPass(agentId, modelId, turnModelId, contextWindow, budget, false, 0, options);
  }

  if (force) {
    const guardUncompactedCount = uncompactedOutsideFloor;
    // Minimum-yield floor: after a low-yield run, back off for a while (`compaction-brakes.ts`).
    if (compactionIsBraked(agentId, force)) return NO_COMPACTION;
    // Nothing left at the leaf is the case for condensation: the pass below runs no archive and no leaf
    // chunking, and a pass that reclaims nothing arms the backoff through `notePassOutcome`.
    if (guardUncompactedCount < MIN_COMPACTABLE_ROWS) {
      if (options?.untilItFits) return foldOldestProtectedGroup({ agentId, protectedFromSeq: view.protectedFromSeq, condensed: await condenseOnlyPass(agentId, modelId, turnModelId, contextWindow, budget, force, guardUncompactedCount, options),
        fold: async (throughSeq) => (await leavingViewPass(agentId, modelId, contextWindow, { cause: 'out-of-view', throughSeq, rowsLeaving: 0 }, options)).leafCreated });   // never a dead end
      return condenseOnlyPass(agentId, modelId, turnModelId, contextWindow, budget, force, guardUncompactedCount, options);
    }

    logger.info('Running full reactive compaction', {
      assembledTokens: totalTokens,
      budgetTokens: budget,
      uncompactedOutsideTail: guardUncompactedCount,
    }, agentId);


    // Archive raw messages to the vault BEFORE compaction destroys them; if archival fails, ABORT (better a
    // bloated context than lost data). An agent on the Dreamer ignore list skips the archive (null): do not abort.
    const messagesForArchive = outsideProtected();
    const archiveCompactedIds = getCompactedMessageIds(agentId);
    // Never re-archive what the vault already holds (a reset archives without marking compacted): bound by
    // rowid; a missing rowid falls to "include", so the safe direction is to archive. Bounds the ARCHIVE input only.
    const archiveHighWater = getArchiveHighWaterMark(agentId);
    const uncompactedForArchive = messagesForArchive.filter(
      m => !archiveCompactedIds.has(m.id) && (archiveHighWater == null || m.rowid == null || m.rowid > archiveHighWater),
    );
    // Service agents are excluded from archival (it returns null for them): that null is not a failed archive.
    // Their histories are plumbing, so compaction proceeds.
    if (uncompactedForArchive.length > 0 && !isDreamerIgnored(agentId) && !isSystemServiceAgent(agentId)) {
      const archiveId = archiveMessagesBeforeCompaction(agentId, uncompactedForArchive);
      if (!archiveId) {
        logger.error('Archive failed, aborting compaction to prevent data loss', { agentId, messageCount: uncompactedForArchive.length }, agentId);
        return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
      }
    }

    // Yield is measured on demand (summaries held plus the live tail): the trim already caps what is sent.
    const demand = (v: ContextView): number => v.summaryRawTokens + v.tailTokens;
    const tokensBefore = demand(view);
    const leaf = await withCompactionActivity(agentId, () => eachWriter(agentId, modelId,
      (writer, left) => runLeafCompaction(agentId, writer, contextWindow,
        { abortSignal: options?.abortSignal, left, throughSeq: view.protectedFromSeq - 1, floorRows: 1 }), options?.abortSignal));
    const leafCreated = leaf.leafCreated;
    modelId = leaf.writer;   // the writer that wrote (or the last one tried) writes the condensation too
    const condensation = starved ? null : await condenseUntilFits(condenseArgs(agentId, modelId, turnModelId, contextWindow, options?.abortSignal));
    const condensedCreated = condensation?.condensedCreated ?? 0;
    rebuildContextItems(agentId);
    // The prefix has just been rewritten: the one instant retiring reasoning costs no cache reuse.
    if (leafCreated > 0) { ageOutReplayedReasoning(agentId); stubOldToolResultsAtBoundary(agentId); }

    const tokensAfter = demand((await measured(agentId, contextWindow, turnModelId)).view);
    const tokensReclaimed = tokensBefore - tokensAfter;

    const result = { leafCreated, condensedCreated, tokensReclaimed: Math.max(tokensReclaimed, 0) };

    // The stage the condenser named travels with the numbers, so a pass that reclaimed nothing says which refused.
    const waiting = spanWaitsForAWriter(agentId);   // with no writer able to run, the pass is a wait, never a brake
    const lowYield = result.tokensReclaimed < 2000 && result.leafCreated <= 1;
    if (!isStopFenced(agentId)) notePassOutcome(agentId, Boolean(force), result, { ...passFacts(condensation, budget, guardUncompactedCount, agentId, modelId), assembledTokens: tokensAfter, tokensBefore, waiting, lowYield }, options?.abortSignal);
    broadcast({
      type: 'memory:compaction',
      agentId,
      ...result,
    });

    if (
      (result.leafCreated > 0 || result.condensedCreated > 0 || result.tokensReclaimed > 1000) &&
      shouldShowCompactionDivider(agentId)
    ) {
      insertCompactionDivider(agentId, {
        label: `Memory Compacted${result.tokensReclaimed > 0 ? `, reclaimed ~${formatTokens(result.tokensReclaimed)}` : ''}${result.leafCreated > 0 ? ` (${result.leafCreated} new summar${result.leafCreated === 1 ? 'y' : 'ies'})` : ''}`,
      });
    }

    logger.info('Compaction complete', result, agentId);
    return result;
  }

  // No proactive leaf arm: `rowsLeavingView` and `leavingViewPass` fold rows as they leave the view.
  logger.info('Compaction skipped: the view holds every summary and nothing is leaving it', {
    assembledTokens: totalTokens, budgetTokens: budget,
  }, agentId);
  return { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 };
}

// ── The recursion's call-site helpers ──
// The policy lives in `memory/condense-until-fits.ts`; it takes the single estimate and `rebuildContextItems`
// as arguments, so there is never a second estimator.

/** THE single estimate, memoised on the facts that move it (`assembled-estimate-cache.ts`). */
async function measured(agentId: string, contextWindow: number, turnModelId: string): Promise<Awaited<ReturnType<typeof estimateAssembledTokens>>> {
  return await cachedAssembledEstimate(agentId, contextWindow, turnModelId,
    () => estimateAssembledTokens(agentId, contextWindow, turnModelId)) as Awaited<ReturnType<typeof estimateAssembledTokens>>;
}

function condenseArgs(
  agentId: string, modelId: string, turnModelId: string, contextWindow: number,
  abortSignal?: AbortSignal,
): Parameters<typeof condenseUntilFits>[0] {
  return {
    agentId, modelId,
    minFanout: DEFAULTS.condensedMinFanout,
    abortSignal,
    measure: () => measured(agentId, contextWindow, turnModelId),
    rebuild: () => rebuildContextItems(agentId),
  };
}

function passFacts(
  condensation: CondensationOutcome | null, budgetTokens: number,
  compactableRows: number, agentId: string, modelId: string,
): Parameters<typeof notePassOutcome>[3] {
  return {
    stage: condensation?.refusedStage ?? null, detail: condensation?.refusedDetail ?? null,
    assembledTokens: condensation?.assembledTotalAfter, budgetTokens,
    summaryTokens: condensation?.summaryTokensAfter, admittedSummaryTokens: condensation?.admittedSummaryTokens,
    compactableRows, topLevelSummaries: condensableSummaries(agentId, { modelId, minFanout: DEFAULTS.condensedMinFanout }), modelId,
  };
}

/** The leaf-less pass: over budget with nothing raw left to fold, so condensation only
 *  (no archive, no leaf chunking). */
async function condenseOnlyPass(
  agentId: string, modelId: string, turnModelId: string, contextWindow: number,
  budget: number, force: boolean, compactableRows: number, options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const args = condenseArgs(agentId, modelId, turnModelId, contextWindow, options?.abortSignal);
  // Asked before any summary call, so a tail-bloated agent with nothing to fold costs no writer work.
  const est = await args.measure() as Awaited<ReturnType<typeof estimateAssembledTokens>>;
  if (rawContextSummaryTokens(agentId) <= est.summaryTokens || est.view.budgetTokens === 0) {
    logger.info('Compaction skipped: nothing outside the protected recent part, and every summary already fits', {
      assembledTokens: est.total, budgetTokens: budget, uncompactedOutsideTail: compactableRows,
    }, agentId);
    return { ...NO_COMPACTION, cannotHelp: true };
  }
  // Only notes of one depth merge, where a writer is left for them; else the oldest leave the view whole.
  if (condensableSummaries(agentId, { modelId, minFanout: DEFAULTS.condensedMinFanout }) < 2) return { ...NO_COMPACTION, cannotHelp: true };
  const condensation = await withCompactionActivity(agentId, () => condenseUntilFits(args));
  // Reclaimed is counted in summary tokens, not the gate's total (which reports the capped figure and cannot move):
  // what these tokens buy is oldest summaries not being dropped.
  const result = {
    leafCreated: 0, condensedCreated: condensation.condensedCreated,
    tokensReclaimed: Math.max(condensation.summaryTokensBefore - condensation.summaryTokensAfter, 0),
  };
  if (!isStopFenced(agentId)) notePassOutcome(agentId, force, result, { ...passFacts(condensation, budget, compactableRows, agentId, modelId), waiting: spanWaitsForAWriter(agentId) }, options?.abortSignal);
  broadcast({ type: 'memory:compaction', agentId, ...result });
  logger.info('Condensation-only compaction complete', {
    ...result, levels: condensation.levels, modelCalls: condensation.modelCalls,
    deepestDepth: condensation.deepestDepth, fits: condensation.fits,
    summaryTokens: condensation.summaryTokensAfter, admittedSummaryTokens: condensation.admittedSummaryTokens,
    assembledTokens: condensation.assembledTotalAfter, budgetTokens: budget,
  }, agentId);
  return result;
}

/** The one archive step before rows are covered: a failed archive REFUSES the cover, so nothing is marked done
 *  that the vault never received. */
export function archiveBeforeCovering(agentId: string, rows: readonly Message[]): boolean {
  const highWater = getArchiveHighWaterMark(agentId);
  const toArchive = rows.filter(m => highWater == null || m.rowid == null || m.rowid > highWater);
  if (toArchive.length === 0 || isDreamerIgnored(agentId) || isSystemServiceAgent(agentId)) return true;
  if (archiveMessagesBeforeCompaction(agentId, [...toArchive])) return true;
  logger.error('Archive failed, refusing to cover these rows to prevent data loss', { agentId, messageCount: toArchive.length }, agentId);
  return false;
}

/**
 * The leaving-view pass: fold exactly the rows `rowsLeavingView` named, through the leaf machinery on one bounded
 * span, never what the agent still reads. Cause 'out-of-view' is exempt from the brake (those rows are owed their
 * fold now): it neither is blocked by it nor arms or resets it.
 */
export async function leavingViewPass(
  agentId: string, modelId: string, contextWindow: number, leaving: LeavingView,
  options?: CheckAndCompactOptions,
): Promise<CompactionResult> {
  const outOfView = leaving.cause === 'out-of-view';
  if (!outOfView && compactionIsBraked(agentId, false)) return NO_COMPACTION;
  logger.info('Condensing rows leaving the live view', {
    cause: leaving.cause, rowsLeaving: leaving.rowsLeaving, throughSeq: leaving.throughSeq,
  }, agentId);

  const compactedIds = getCompactedMessageIds(agentId);
  const floorRows = 1;
  const span = getMessagesOutsideFreshTail(agentId, floorRows)
    .filter(m => !compactedIds.has(m.id) && (m.rowid ?? Number.POSITIVE_INFINITY) <= leaving.throughSeq);
  // An empty span is no work: nothing is archived, written or shown, and no brake is armed.
  if (span.length === 0) {
    logger.info('Leaving-view condense skipped: every row through the boundary already has its summary', { cause: leaving.cause, throughSeq: leaving.throughSeq }, agentId);
    return NO_COMPACTION;
  }
  if (!archiveBeforeCovering(agentId, span)) return NO_COMPACTION;

  const pass = (writer: string, left?: LeftBehind): Promise<number> => runLeafCompaction(agentId, writer, contextWindow,
    { abortSignal: options?.abortSignal, throughSeq: leaving.throughSeq, floorRows, left });
  // The out-of-view door walks the writers itself; every other leaving-view pass hands on.
  const leafCreated = await withCompactionActivity(agentId, async () => outOfView
    ? pass(modelId) : (await eachWriter(agentId, modelId, pass, options?.abortSignal)).leafCreated);
  rebuildContextItems(agentId);
  if (leafCreated > 0) { ageOutReplayedReasoning(agentId); stubOldToolResultsAtBoundary(agentId); }

  const result = { leafCreated, condensedCreated: 0, tokensReclaimed: 0 };
  if (!outOfView && !isStopFenced(agentId)) notePassOutcome(agentId, false, result, { waiting: spanWaitsForAWriter(agentId) }, options?.abortSignal);   // a Stopped pass is not an outcome
  broadcast({ type: 'memory:compaction', agentId, ...result });
  if (leafCreated > 0 && shouldShowCompactionDivider(agentId)) {
    insertCompactionDivider(agentId, {
      label: `Memory Compacted (${leafCreated} summar${leafCreated === 1 ? 'y' : 'ies'} of messages leaving view)`,
    });
  }
  logger.info('Leaving-view condense complete', { ...result, cause: leaving.cause }, agentId);
  return result;
}

/** With nothing outside the protected recent part, a boundary refusal's pass folds that part's OLDEST whole
 *  exchange (never the newest), so every round makes progress. */
async function foldOldestProtectedGroup(args: {
  agentId: string; protectedFromSeq: number; condensed: CompactionResult; fold: (throughSeq: number) => Promise<number>;
}): Promise<CompactionResult> {
  const { agentId, protectedFromSeq, condensed } = args;
  if (progressed(condensed)) return condensed;
  const compacted = getCompactedMessageIds(agentId);
  const groups = groupTail(getMessagesOutsideFreshTail(agentId, 1).filter((m) => !compacted.has(m.id) && (m.rowid ?? 0) >= protectedFromSeq));
  // The first group and every group after it up to the next row a person or peer sent: a view opens on a user row.
  let end = 0;
  while (end + 1 < groups.length && groups[end + 1].messages[0].role !== 'user') end++;
  const oldest = groups.length > 1 ? groups.slice(0, end + 1).flatMap((g) => g.messages) : [];
  const throughSeq = oldest.length > 0 ? oldest[oldest.length - 1].rowid ?? 0 : 0;
  const result: CompactionResult = { leafCreated: throughSeq > 0 ? await args.fold(throughSeq) : 0, condensedCreated: condensed.condensedCreated, tokensReclaimed: condensed.tokensReclaimed };
  logger.info('forced pass: nothing outside the protected recent part; folded its oldest group', { throughSeq, leafCreated: result.leafCreated, groupsLeft: groups.length - 1 }, agentId);
  notePassOutcome(agentId, true, result, { waiting: spanWaitsForAWriter(agentId) });
  return result;
}

/** What a leaf pass left behind: a row more than its writer holds, and where the covering of stranded rows starts. */
interface LeftBehind { tooBig: boolean; fromSeq?: number }

/** Run `pass` with `first`, then with each next eligible writer while the last one failed or left a row it could not
 *  hold; after the last, the rows no writer took are covered by placeholder notes. A Stop hands nothing on. */
async function eachWriter(agentId: string, first: string, pass: (writer: string, left: LeftBehind) => Promise<number>, abortSignal?: AbortSignal): Promise<{ leafCreated: number; writer: string }> {
  const tried = new Set<string>();
  const left: LeftBehind = { tooBig: false };
  let writer = first;
  let leafCreated = 0;
  for (;;) {
    tried.add(writer);
    left.tooBig = false;
    leafCreated += await pass(writer, left);
    const next = abortSignal?.aborted || isStopFenced(agentId) || !(left.tooBig || writerPassedOver(writer, agentId)) ? undefined
      : eligibleSummaryWriters(ownModel(agentId), agentId).find((w) => !tried.has(w));
    if (!next) { await coverRowsStrandedBelowBoundary(agentId, left.fromSeq ?? 0); return { leafCreated, writer }; }
    logger.info('The summary writer failed or could not hold a row; the next eligible writer takes the span at once', { from: writer, next }, agentId);
    writer = next;
  }
}

// ── The age-out, and the boundary it may never cross ──
// Stored `reasoning_content` replays on every tool-call row in the live tail, though nothing re-reads it once
// the chain is done. Dropping it changes bytes the provider has cached, so it happens ONLY when the prefix is being
// rewritten anyway (a compaction that created a leaf summary). Rows of the current turn keep theirs; a failing
// `currentTurnNumber` answers 0, which retires nothing.

/** Retire the reasoning of every row older than the ACTIVE turn. One-way, durable, and only called from a
 *  compaction that has already rewritten this agent's prefix. Returns the number of rows retired. */
export function ageOutReplayedReasoning(agentId: string): number {
  const activeTurn = currentTurnNumber(agentId);
  const rowsRetired = retireReplayedReasoningBeforeTurn({ agentId, activeTurn });
  if (rowsRetired > 0) {
    logger.info('Retired replayed reasoning at a compaction boundary', {
      rowsRetired, activeTurnProtected: activeTurn,
    }, agentId);
  }
  return rowsRetired;
}

// ── The tool-result stub watermark crosses the same boundary ──
// Only the stub DECISION is made here, at a compaction that rewrote the prefix: a monotonic watermark
// (`agents.config.toolResultsStubbedBeforeTurn`) the assembler reads and applies to results older than
// `V2_STUB_AFTER_TURNS`; deriving it from the live turn counter would rewrite cached bytes mid-session.

export function stubOldToolResultsAtBoundary(agentId: string): number {
  const activeTurn = currentTurnNumber(agentId);
  const before = activeTurn - V2_STUB_AFTER_TURNS;
  if (!Number.isFinite(before)) return 0;
  const db = getDb();
  const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as
    { config: string | null } | undefined;
  let cfg: Record<string, unknown> = {};
  try { cfg = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {}; } catch { cfg = {}; }
  const prior = typeof cfg.toolResultsStubbedBeforeTurn === 'number'
    ? cfg.toolResultsStubbedBeforeTurn : Number.NEGATIVE_INFINITY;
  const next = Math.max(prior, before);
  if (!(next > prior)) return 0;
  cfg.toolResultsStubbedBeforeTurn = next;
  db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify(cfg), agentId);
  logger.info('Advanced the tool-result stub watermark at a compaction boundary', {
    watermarkTurn: next, activeTurn,
  }, agentId);
  return next;
}


/** The summarizer's one leaf input builder; `memory/summary-rebuild.ts` replays it, so a second copy would let the
 *  rebuild measure a summariser that does not exist. It filters platform noise, tags each party, and scrubs
 *  technique bodies and credential values (`scrubStubFor`) out of what a persisted summary will hold. */
export function buildLeafSummaryInput(messages: Message[], budgetTokens: number = getLeafChunkTokens()): string {
  const answered = answeredAskTurns(messages);
  const { one, labelOf } = conversationLabels(messages);
  return fitInputToBudget((keep) => {
    const body = messages
      .filter(m => !isNonConversationForSummary(m.content))
      .map(m => {
        const party = summaryPartyTag(m);
        const at = renderInstant(m.createdAt);
        const parts = [m.role.toUpperCase(), party, at, one ? null : `in ${labelOf.get(m.id) ?? 'conversation unknown'}`];
        const base = parts.filter((p): p is string => !!p).join(' · ');
        const servedBy = answered.get(m.id);
        const tag = servedBy == null ? base : `${base} · ${ANSWERED_TAG} in turn ${servedBy}`;
        return `[${tag}] ${condenseToolJsonForSummary(scrubTechniqueContentForSummary(m.content), keep)}`;
      })
      .join('\n\n---\n\n');
    return body && one ? `CONVERSATION: ${labelOf.get(messages[0].id)}\n\n${body}` : body;
  }, budgetTokens);
}

/** The literal the input builder writes and the summariser's instruction names. Free of `]` on purpose:
 *  `summary-rebuild.ts`'s `ROLE_TAG_RE` strips `^\s*\[(USER|…)\b[^\]]*\]`, and a bracket would break its replay. */
export const ANSWERED_TAG = 'ANSWERED';

/** The ask's answered state travels with the ask, so a summary cannot let the model re-run finished asks. It is
 *  read from the LEDGER (`messages.answer_message_id` / `served_by_turn`), never inferred from prose, and resolved
 *  at write because summaries ride the cacheable prefix; `summary-rebuild.ts` replays through the same builder. */
function answeredAskTurns(messages: Message[]): Map<string, number> {
  const out = new Map<string, number>();
  const asks = messages.filter(m => m.role === 'user');
  if (asks.length === 0) return out;
  try {
    const stmt = getDb().prepare(
      `SELECT served_by_turn AS turn FROM messages
        WHERE id = ? AND answer_message_id IS NOT NULL AND served_by_turn IS NOT NULL`,
    );
    for (const ask of asks) {
      const row = stmt.get(ask.id) as { turn: number } | undefined;
      if (row) out.set(ask.id, row.turn);
    }
  } catch { /* best effort: a missing stamp must never cost the summary itself */ }
  return out;
}

/** Does this span hold anything the ledger calls CONVERSATION? The placeholder branch marks rows compacted
 *  (destroying them), so its "no user conversation" claim comes from the record, not the content filter. */
function spanHoldsConversation(agentId: string, messageIds: string[]): boolean {
  const stmt = getDb().prepare(
    `SELECT 1 FROM messages m
      WHERE m.agent_id = ? AND m.id = ?
        AND ( (m.role = 'user' AND m.lane = 'owner')
           OR m.answer_message_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM messages a
                       WHERE a.agent_id = m.agent_id AND a.answer_message_id = m.id)
           OR EXISTS (SELECT 1 FROM turns t
                       WHERE t.agent_id = m.agent_id AND t.answer_message_id = m.id) )
      LIMIT 1`,
  );
  for (const id of messageIds) {
    if (stmt.get(agentId, id)) return true;
  }
  return false;
}

export async function runLeafCompaction(
  agentId: string,
  modelId: string,
  contextWindow?: number,
  opts?: {
    abortSignal?: AbortSignal;
    /** Fold only rows with `seq <= throughSeq` (the leaving-view span). Absent: the pressure path's input. */
    throughSeq?: number;
    /** The newest rows this fold may not take; the floor bounds what PRESSURE may fold, not what the trim took. */
    floorRows?: number;
    /** Set when a row was more than this writer holds, so the fallback can offer it to one that can. */
    left?: LeftBehind;
  },
): Promise<number> {
  const cw = contextWindow ?? 200000;
  const messagesOutside = getMessagesOutsideFreshTail(agentId, opts?.floorRows ?? getFreshTailCount(cw));
  const compactedIds = getCompactedMessageIds(agentId);
  const through = opts?.throughSeq;

  const uncompacted = messagesOutside.filter(m => !compactedIds.has(m.id)
    && (through === undefined || (m.rowid ?? Number.POSITIVE_INFINITY) <= through));

  if (uncompacted.length === 0) {
    logger.debug('No messages to compact', {}, agentId);
    return 0;
  }

  const room = summaryRoom(modelId);
  if (room <= 0) return 0;
  const ownModel = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
  const viewBudget = ownModel ? await measured(agentId, cw, ownModel).then((m) => m.view.budgetTokens, () => 0) : 0;
  const keepCap = leafKeepCap(viewBudget, undefined, modelCharsPerToken(modelId));   // in the writer's tokens
  const span = Math.min(getLeafChunkTokens(), room, Math.ceil(keepCap / summaryShare()));
  const chunks = chunkMessages(uncompacted, span);
  const inputBudget = Math.max(0, span - Math.min(getLeafTargetTokens(), keepCap));
  const writerWasAnswering = !writerPassedOver(modelId, agentId);

  logger.info('Leaf compaction: processing chunks', {
    totalMessages: uncompacted.length,
    chunkCount: chunks.length,
  }, agentId);

  let summariesCreated = 0;

  while (chunks.length > 0) {
    const chunk = chunks.shift()!;
    if (chunk.length === 0) continue;
    if (summaryWriterUnavailable(agentId, modelId)) break;   // do not build what cannot be sent
    if (writerWasAnswering && writerPassedOver(modelId, agentId)) break;   // it failed on the chunk before

    const content = buildLeafSummaryInput(chunk, inputBudget);

    const messageIds = chunk.map(m => m.id);
    const earliestAt = chunk[0].createdAt;
    const latestAt = chunk[chunk.length - 1].createdAt;

    try {
      if (opts?.abortSignal?.aborted) {
        logger.info('Leaf compaction aborted before chunk started', {
          messageCount: chunk.length, summariesCreated,
        }, agentId);
        break;
      }
      // A chunk that was ENTIRELY plumbing has no conversation to summarize: record a minimal placeholder. That is
      // the LEDGER's verdict, not the content filter's: where they disagree the span is LEFT UNCOMPACTED.
      if (content.trim().length === 0) {
        if (spanHoldsConversation(agentId, messageIds)) {
          logger.warn('COMPACTION_REFUSED filtered-empty chunk holds ledger conversation; left uncompacted', {
            messageCount: chunk.length, earliestAt, latestAt,
          }, agentId);
          continue;
        }
        createLeafSummary(
          agentId,
          NO_CONVERSATION_PLACEHOLDER,
          estimateTokens(NO_CONVERSATION_PLACEHOLDER),
          messageIds,
          earliestAt,
          latestAt,
        );
        supersedeUncondensedPlaceholders(agentId, messageIds);   // one note per row
        summariesCreated++;
        continue;
      }

      const summary = await generateSummary({
        content,
        depth: 0,
        targetTokens: Math.min(summaryTargetTokens(content, modelCharsPerToken(modelId)), leafKeepCap(viewBudget, conversationLabels(chunk).labelOf.get(chunk[0].id), modelCharsPerToken(modelId))),
        agentId,
        modelId,
        abortSignal: opts?.abortSignal, spanIds: messageIds, spanOpen: chunks.length === 0,   // known by its rows; the last chunk is open
      });

      // A REFUSAL leaves the chunk uncompacted (`createLeafSummary` is what marks rows compacted), so the next
      // drain retries it; a placeholder here would be a lie about a span the summariser never read.
      if (!summary.ok) {
        if (summary.tooBig) {   // not dialled, more than it can hold: halved; a single row is left for a writer that can
          if (chunk.length > 1 && !summary.noRoom) chunks.unshift(chunk.slice(0, Math.ceil(chunk.length / 2)), chunk.slice(Math.ceil(chunk.length / 2)));
          else if (opts?.left) opts.left.tooBig = true;
          if (summary.noRoom) break;   // this writer cannot run now; nothing is halved, the rest waits
          continue;
        }
        (summary.checkFailed ? logger.debug : logger.warn)('SUMMARY_REFUSED leaf chunk left uncompacted', {
          messageCount: chunk.length, reason: summary.reason,
        }, agentId);
        if (summary.stopped) break;   // the owner stopped this agent
        continue;
      }

      // The cited work id is resolved against the spine at write, not render (summaries ride the cacheable
      // prefix). The agent is passed because the id-less leg is agent-scoped: it matches only THIS agent's rows.
      const resolvedText = annotateSummaryObligations(summary.text, agentId);
      createLeafSummary(
        agentId,
        resolvedText,
        resolvedText === summary.text ? summary.tokenCount : estimateTokens(resolvedText),
        messageIds,
        earliestAt,
        latestAt,
      );
      supersedeUncondensedPlaceholders(agentId, messageIds);   // one note per row

      summariesCreated++;
    } catch (err) {
      logger.error('Failed to create leaf summary for chunk', {
        messageCount: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // Rows a refused chunk left below a landed one are covered now (placeholder notes), asked on EVERY fold, even
  // one that landed nothing. Under the writer fallback (`opts.left`) the covering waits for the LAST writer.
  if (opts?.left) opts.left.fromSeq ??= uncompacted[0].rowid ?? 0;
  else await coverRowsStrandedBelowBoundary(agentId, uncompacted[0].rowid ?? 0);
  return summariesCreated;
}

/** `tail-horizon.ts` names the rows; the placeholder writer covers them (caller holds the compaction lock). */
async function coverRowsStrandedBelowBoundary(agentId: string, fromSeq: number): Promise<void> {
  const { anchor, stranded } = rowsStrandedBelowBoundary(agentId, fromSeq);
  if (stranded === 0) return;
  const covered = (await import('./out-of-view.js')).writeUncondensedPlaceholders(agentId, anchor);
  logger[covered > 0 ? 'warn' : 'error'](covered > 0 ? 'Rows were left below the summarised boundary; placeholder notes now stand in for them'
    : 'Rows were left below the summarised boundary and could NOT be covered (the vault archive was refused); they stay owed and the next fold retries', { stranded, covered, anchor }, agentId);
}


export function rebuildContextItems(agentId: string): void {
  // Get all summaries that are NOT parents in summary_parents
  // i.e., the "leaf nodes" of the DAG (top of the tree, highest depth)
  const db = getDb();

  const agentModel = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  let contextWindow = 200000; // default
  if (agentModel?.model_id) {
    const model = db.prepare('SELECT context_window FROM models WHERE id = ?').get(agentModel.model_id) as { context_window: number | null } | undefined;
    if (model?.context_window) contextWindow = model.context_window;
  }

  interface TopLevelRow {
    id: string;
    earliest_at: string;
  }

  const topLevel = db.prepare(`
    SELECT s.id, s.earliest_at FROM summaries s
    WHERE s.agent_id = ?
      AND s.id NOT IN (
        SELECT parent_id FROM summary_parents
      )
    ORDER BY s.earliest_at ASC, s.id ASC
  `).all(agentId) as TopLevelRow[];

  const freshTail = getRecentMessages(agentId, getFreshTailCount(contextWindow));

  const items: Array<{ itemType: 'message' | 'summary'; itemId: string }> = [];

  for (const summary of topLevel) {
    items.push({ itemType: 'summary', itemId: summary.id });
  }

  for (const msg of freshTail) {
    items.push({ itemType: 'message', itemId: msg.id });
  }

  replaceContextItems(agentId, items);

  logger.info('Rebuilt context items', {
    summaryCount: topLevel.length,
    freshTailCount: freshTail.length,
  }, agentId);
}


// Persisted tool rows (and assistant tool_use rows) are raw JSON arrays; the summarizer gets lines that keep WHAT
// happened (tool name, ok/error, the result) without the wire format. Pure text content passes through untouched.
export function condenseToolJsonForSummary(content: string, keep: number = 1): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const lines: string[] = [];
    for (const b of arr) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: string; name?: string; text?: string; content?: unknown; is_error?: boolean; input?: unknown; tool_use_id?: unknown };
      if (block.type === 'tool_use') {
        lines.push(`(called tool ${block.name ?? 'unknown'})`, ...authoredInputLines(block.name ?? 'unknown', block.input, keep));
      } else if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        lines.push(`(tool result${block.is_error ? ' ERROR' : ''}: ${resultForSummary(resultText(block.content), id, keep)})`);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(block.text);
      }
    }
    return lines.length > 0 ? lines.join('\n') : content;
  } catch {
    return content; // not JSON after all
  }
}

/** Chunks NEVER cross conversations: rows are grouped by conversation (`summary-subject.ts`), then cut by tokens. */
export function chunkMessages(messages: Message[], targetTokens: number): Message[][] {
  if (messages.length === 0) return [];
  return groupBySubject(messages[0].agentId, messages).flatMap((g) => chunkByTokens(g.rows, targetTokens));
}

function chunkByTokens(messages: Message[], targetTokens: number): Message[][] {
  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = msg.tokenCount ?? estimateTokens(msg.content);

    if (currentTokens + msgTokens > targetTokens && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}
