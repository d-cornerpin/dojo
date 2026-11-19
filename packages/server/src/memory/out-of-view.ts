// No row is ever out of the agent's view without something in view standing for it: a summary, or a placeholder
// note built from stored columns only (no model writes it, so it always lands). A turn folds its own overflow within
// its patience; a backlog larger than one summary (a window that shrank) gets placeholders at once, and the
// background folder replaces them gradually, one note at a time, yielding to the agent's live turn.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { backgroundDrains, registerAbortable, releaseAbortable } from '../agent/shared-state.js';
import { getUnsummarisedRows, unsummarisedCost } from './store.js';
import { createLeafSummary, deleteSummary, getSummarySourceMessages, updateSummaryContent } from './dag.js';
import { UNCONDENSED_KIND, placeholderText, supersedeUncondensedPlaceholders } from './uncondensed-head.js';
import {
  archiveBeforeCovering, buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, leavingViewPass,
  NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { generateSummary } from './summarize.js';
import { LEAF_CHUNK_TOKENS, summaryTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { KEPT_WHOLE_KIND, keptRowHandle } from './kept-row-view.js';
import { toolResultView, POINTER_VIEW_CHARS } from './tool-result-view.js';
import { refreshEmbedding } from './embeddings.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { summaryCheckRefusedSince } from './summary-check.js';
import { turnPatienceMs } from './turn-patience.js';
import { agentBusy } from './rebuild-signals.js';
import { ownerProgressFrame } from '../healer/owner-notices.js';
import {
  abortBlamesWriter, eligibleSummaryWriters, markWaiting, ownModel, pickWriter, spanKeyOf, spanUnwritable, spanWaitsForAWriter,
  summaryWriterCandidates, EVERY_AGENT, FOLD_IN_TURN_LIMIT, FOLD_STOPPED_BY_OWNER,
} from './writer.js';
import { compactionFailureReason, noteCompactionRecovered, reportCompactionDefect } from './compaction-defect.js';
import { keepsNoSummaries } from './pm-view.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-out-of-view');

/** Unsummarised rows of this session at or below `throughSeq`, by count and cost. */
const owedThrough = (agentId: string, throughSeq: number): { rows: number; tokens: number } => unsummarisedCost(agentId, 1, { throughSeq });

export function hasUncondensedPlaceholders(agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM summaries WHERE agent_id = ? AND kind = ? LIMIT 1').get(agentId, UNCONDENSED_KIND);
}

/** Cover every still-unsummarised row at or below `throughSeq` with placeholders, one per leaf chunk, after the
 *  vault archive (a failed archive refuses the cover). The caller holds the compaction lock. Returns rows covered. */
export function writeUncondensedPlaceholders(agentId: string, throughSeq: number): number {
  const owed = getUnsummarisedRows(agentId, 1, { throughSeq });
  if (owed.length === 0 || !archiveBeforeCovering(agentId, owed)) return 0;
  for (const chunk of chunkMessages(owed, getLeafChunkTokens())) if (chunk.length > 0) placeholderFor(agentId, chunk);
  logger.warn('Rows left the live view with no summary written in time; placeholders stand in until one is', { rows: owed.length, throughSeq }, agentId);
  return owed.length;
}

function placeholderFor(agentId: string, rows: readonly Message[]): string {
  const text = placeholderText(rows);
  return getDb().transaction(() => {
    const note = createLeafSummary(agentId, text, estimateTokens(text), rows.map((m) => m.id), rows[0].createdAt, rows[rows.length - 1].createdAt);
    getDb().prepare('UPDATE summaries SET kind = ? WHERE id = ?').run(UNCONDENSED_KIND, note.id);
    return note.id;
  })();
}

// ── The catch-up record: one config row per agent while a backlog is folded in the background. `askedThrough` is
//    the newest person's message when it began; `carded` says its progress glyph is shown.

interface CatchUp { at: number; askedThrough?: number; carded?: boolean }
const CATCH_UP = 'memory_catch_up.';
const progressKeyOf = (agentId: string): string => `memory-catch-up:${agentId}`;
const PROGRESS_LABEL = 'Summarising older memory';

function readCatchUp(agentId: string): CatchUp | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(CATCH_UP + agentId) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as CatchUp : null; } catch { return { at: 0 }; }
}
function writeCatchUp(agentId: string, value: CatchUp | null): void {
  if (value === null) getDb().prepare('DELETE FROM config WHERE key = ?').run(CATCH_UP + agentId);
  else setConfigValue(CATCH_UP + agentId, JSON.stringify(value));
}
const newestAsk = (agentId: string): number =>
  (getDb().prepare("SELECT MAX(seq) AS r FROM messages WHERE agent_id = ? AND role = 'user'").get(agentId) as { r: number | null }).r ?? 0;

export function catchUpStands(agentId: string): boolean {
  try { return readCatchUp(agentId) !== null && hasUncondensedPlaceholders(agentId); } catch { return false; }
}

/** Are the rows out of view through `throughSeq` the background folder's: a catch-up standing, or more than one
 *  summary's worth? A read that fails answers no, so the turn folds them itself. */
export function catchUpOwns(agentId: string, throughSeq: number): boolean {
  try {
    if (catchUpStands(agentId)) return true;
    endCatchUpIfDone(agentId);
    if (throughSeq <= 0) return false;
    return owedThrough(agentId, throughSeq).tokens > LEAF_CHUNK_TOKENS;
  } catch { return false; }
}

function beginCatchUp(agentId: string, rowsLabelled: number): void {
  try {
    if (readCatchUp(agentId) !== null) return;
    writeCatchUp(agentId, { at: Date.now(), askedThrough: newestAsk(agentId) });
    logger.info('Catch-up: older history no longer fits this agent\'s window; it is folded in the background, a span at a time', { rowsLabelled }, agentId);
  } catch (err) {
    logger.warn('Catch-up could not be recorded; the notes stand and the folder still replaces them', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** The folder landed its last note: the catch-up is over, and its glyph leaves every open dashboard. */
export function endCatchUpIfDone(agentId: string): void {
  try {
    const was = readCatchUp(agentId);
    if (was === null || hasUncondensedPlaceholders(agentId)) return;
    writeCatchUp(agentId, null);
    logger.info('Catch-up finished: every older span has its summary', {}, agentId);
    if (was.carded) ownerProgressFrame('end', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* the record stays; the next landing note ends it */ }
}

/** A person's turn starting while the agent still runs on notes shows the glyph, never while a compaction failure
 *  speaks for the agent (the work is not moving then). Never throws. */
export function showCatchUpAtTurnStart(agentId: string): void {
  try {
    const rec = readCatchUp(agentId);
    if (rec === null || compactionFailureReason(agentId) !== null || !hasUncondensedPlaceholders(agentId)) return;
    if (newestAsk(agentId) <= (rec.askedThrough ?? 0)) return;
    if (!rec.carded) writeCatchUp(agentId, { ...rec, carded: true });
    ownerProgressFrame('start', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* the glyph is the courtesy; the folder works regardless */ }
}

/** A compaction failure was told for this agent: the glyph that says the work is moving leaves. */
export function withdrawCatchUpProgress(agentId: string): void {
  try {
    const rec = readCatchUp(agentId);
    if (!rec?.carded) return;
    writeCatchUp(agentId, { ...rec, carded: false });
    ownerProgressFrame('end', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* best effort */ }
}

/** The live agents whose catch-up record is open (the boot resumes each). */
export function openCatchUps(): string[] {
  return (getDb().prepare(`SELECT key FROM config WHERE key LIKE '${CATCH_UP}%'
    AND substr(key, ${CATCH_UP.length + 1}) NOT IN (SELECT id FROM agents WHERE status = 'terminated')`).all() as Array<{ key: string }>).map(({ key }) => key.slice(CATCH_UP.length));
}

// ── The background folder: replaces placeholders with real summaries of exactly their rows.

/** One replacement per agent (sharing the routine condense's one-in-flight slot), only when a placeholder exists
 *  and a writer can run. It does not start mid-turn and stops before its next note when a turn begins. */
export function replacePlaceholdersInBackground(agentId: string): boolean {
  try {
    releaseChangedKeptRows(agentId);
    // An agent that keeps no summaries never folds its old placeholders, so a catch-up it had is over.
    if (keepsNoSummaries(agentId)) { writeCatchUp(agentId, null); return false; }
    endCatchUpIfDone(agentId);
    if (backgroundDrains.has(agentId) || !hasUncondensedPlaceholders(agentId) || agentBusy(agentId) || pickWriter(agentId) === null) return false;
  } catch { return false; }
  backgroundDrains.add(agentId);
  replaceUncondensedPlaceholders(agentId, { yieldTo: () => agentBusy(agentId) })
    .catch((err) => { logger.warn('Placeholder replacement failed', { error: err instanceof Error ? err.message : String(err) }, agentId); return 0; })
    .then((replaced) => {
      backgroundDrains.delete(agentId);
      endCatchUpIfDone(agentId);
      if (replaced > 0) replacePlaceholdersInBackground(agentId);
    });
  return true;
}

/** The routine condense's job ended: the slot is handed on, so an open catch-up refused while it ran resumes. */
export function releaseBackgroundSlot(agentId: string): void {
  backgroundDrains.delete(agentId);
  if (catchUpStands(agentId)) replacePlaceholdersInBackground(agentId);
}

/** A row no writer could summarise is shown as the summary input shows it, behind its kept-row pointer when long. */
function keepRowWhole(agentId: string, noteId: string, row: Message): void {
  const shown = buildLeafSummaryInput([row], Number.MAX_SAFE_INTEGER);
  const text = shown.length > POINTER_VIEW_CHARS ? toolResultView(shown, keptRowHandle(row.id), POINTER_VIEW_CHARS) : shown;
  getDb().prepare('UPDATE summaries SET kind = ?, content = ?, token_count = ? WHERE id = ?').run(KEPT_WHOLE_KIND, text, estimateTokens(text), noteId);
  logger.warn('No summary writer could summarise this row whole; it is kept whole behind its pointer until it changes', { messageId: row.id, chars: row.content.length }, agentId);
}

/** A kept-whole row some candidate writer may now hold (its content or the writers changed) is a placeholder again. */
function releaseChangedKeptRows(agentId: string): number {
  const notes = getDb().prepare('SELECT id FROM summaries WHERE agent_id = ? AND kind = ?').all(agentId, KEPT_WHOLE_KIND) as Array<{ id: string }>;
  let released = 0;
  for (const { id } of notes) {
    const rows = getSummarySourceMessages(id);
    if (rows.length === 0) { deleteSummary(id); continue; }
    if (spanUnwritable(agentId, rows)) continue;
    const text = placeholderText(rows);
    getDb().prepare('UPDATE summaries SET kind = ?, content = ?, token_count = ? WHERE id = ?').run(UNCONDENSED_KIND, text, estimateTokens(text), id);
    released++;
  }
  return released;
}

const coveredElsewhere = (messageId: string, placeholderId: string): boolean => !!getDb().prepare(
  `SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id WHERE sm.message_id = ? AND sm.summary_id != ? AND s.kind != ? LIMIT 1`,
).get(messageId, placeholderId, UNCONDENSED_KIND);

/** Replace placeholders oldest first, each with the writers that may take its span, under the compaction lock.
 *  A span every answering writer cannot hold is split, down to single rows; a row no candidate can hold is kept
 *  whole. Returns how many were replaced (or dropped because a real summary covered them). */
export async function replaceUncondensedPlaceholders(agentId: string, opts: { abortSignal?: AbortSignal; yieldTo?: () => boolean } = {}): Promise<number> {
  return (await withLock(`compact:${agentId}`, () => replaceUnderLock(agentId, opts), { ifBusy: 'wait' })) ?? 0;
}

async function replaceUnderLock(agentId: string, opts: { abortSignal?: AbortSignal; yieldTo?: () => boolean }): Promise<number> {
  const queue = (getDb().prepare('SELECT id FROM summaries WHERE agent_id = ? AND kind = ? ORDER BY earliest_at ASC, id ASC')
    .all(agentId, UNCONDENSED_KIND) as Array<{ id: string }>).map((r) => r.id);
  const own = ownModel(agentId);
  let replaced = 0;
  let failedWriter: string | null = null;
  let stopped = false;
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (opts.abortSignal?.aborted || opts.yieldTo?.()) break;
    const all = getSummarySourceMessages(id);
    const source = all.filter((m) => !coveredElsewhere(m.id, id));
    if (source.length === 0) { deleteSummary(id); replaced++; continue; }
    if (source.length < all.length) supersedeUncondensedPlaceholders(agentId, all.filter((m) => !source.includes(m)).map((m) => m.id));
    const content = buildLeafSummaryInput(source);
    let done = content.trim().length === 0;
    if (done) updateSummaryContent(id, NO_CONVERSATION_PLACEHOLDER, estimateTokens(NO_CONVERSATION_PLACEHOLDER));
    let checkFailed = false;
    for (const writer of done ? [] : eligibleSummaryWriters(own, agentId, source)) {
      if (opts.abortSignal?.aborted) break;
      const summary = await generateSummary({ content, depth: 0, targetTokens: summaryTargetTokens(content, modelCharsPerToken(writer)), agentId, modelId: writer, abortSignal: opts.abortSignal, spanIds: source.map((m) => m.id) });
      if (!summary.ok) {
        if (summary.stopped) { stopped = true; break; }
        if (summary.checkFailed) { checkFailed = true; break; }
        if (summary.tooBig) { if (!summary.noRoom && !summary.forNow) markWaiting(agentId, writer, spanKeyOf(source), 'cannot-hold'); continue; }
        if (abortBlamesWriter(opts.abortSignal)) failedWriter = writer;
        continue;
      }
      const text = annotateSummaryObligations(summary.text, agentId);
      updateSummaryContent(id, text, text === summary.text ? summary.tokenCount : estimateTokens(text));
      refreshEmbedding('summary', id, agentId, text);
      done = true;
      break;
    }
    if (checkFailed) continue;
    if (stopped) break;
    if (done) { replaced++; continue; }
    const next = whenNoWriterHoldsIt(agentId, own, id, source, queue);
    if (next === 'kept') replaced++;
    if (next === 'stop') break;
  }
  if (!hasUncondensedPlaceholders(agentId)) noteCompactionRecovered(agentId, 0);
  else if (failedWriter) {
    reportCompactionDefect(agentId, 'summary_writer_unavailable', { modelId: failedWriter, detail: 'placeholder notes could not yet be replaced by summaries' },
      { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
  }
  logger.info('Placeholder replacement pass', { replaced, remaining: hasUncondensedPlaceholders(agentId) }, agentId);
  return replaced;
}

/** A span no answering writer would take: split it (its later half becomes its own placeholder, both queued), keep a
 *  single row no candidate can hold whole behind its pointer, or stop when the writers are out rather than refusing. */
function whenNoWriterHoldsIt(agentId: string, own: string | undefined, id: string, source: Message[], queue: string[]): 'next' | 'kept' | 'stop' {
  const answeringRefused = eligibleSummaryWriters(own, agentId).length > 0 && eligibleSummaryWriters(own, agentId, source).length === 0;
  if (source.length > 1 && answeringRefused) {
    const later = source.slice(Math.ceil(source.length / 2));
    supersedeUncondensedPlaceholders(agentId, later.map((m) => m.id));
    queue.unshift(id, placeholderFor(agentId, later));
    return 'next';
  }
  if (source.length === 1 && spanUnwritable(agentId, source)) { keepRowWhole(agentId, id, source[0]); return 'kept'; }
  return answeringRefused ? 'next' : 'stop';
}

// ── The turn's door: the assembly it dials, with every row out of view represented in view.

/** Recursion bound: a fold that has not converged after this many passes is a defect, and placeholders cover. */
const OUT_OF_VIEW_FOLD_PASSES = 4;

interface TurnBudget { deadline: number; stop?: AbortSignal; tried: Set<string> }

function boundedSignal(deadline: number, stop?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const onStop = (): void => ctl.abort(FOLD_STOPPED_BY_OWNER);
  if (stop?.aborted) onStop(); else stop?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(() => ctl.abort(FOLD_IN_TURN_LIMIT), Math.max(0, deadline - Date.now()));
  (timer as unknown as { unref?: () => void }).unref?.();
  return { signal: ctl.signal, done: () => { clearTimeout(timer); stop?.removeEventListener('abort', onStop); } };
}

/** The engine's assembly door. `assemble` is the one assembly this turn dials; the fold is bounded by the patience of
 *  the dialed model (else the agent's own) and the owner's Stop. Returns an assembly with nothing out of view unrepresented. */
export async function assembleWithNothingOutOfViewUnsummarised<T extends { outOfViewThroughSeq?: number }>(
  agentId: string, contextWindow: number, assemble: () => Promise<T>, opts: { abortSignal?: AbortSignal; dialedModelId?: string } = {},
): Promise<T> {
  const stop = new AbortController();
  registerAbortable(agentId, stop, 'turn');
  showCatchUpAtTurnStart(agentId);
  const onCaller = (): void => stop.abort();
  if (opts.abortSignal?.aborted) onCaller(); else opts.abortSignal?.addEventListener('abort', onCaller, { once: true });
  const budget: TurnBudget = { deadline: Date.now() + turnPatienceMs(agentId, opts.dialedModelId), stop: stop.signal, tried: new Set() };
  try {
    let assembled = await assemble();
    for (let pass = 0; pass <= OUT_OF_VIEW_FOLD_PASSES; pass++) {
      const throughSeq = assembled.outOfViewThroughSeq ?? 0;
      if (throughSeq <= 0 || owedThrough(agentId, throughSeq).rows === 0) return assembled;
      if (pass === OUT_OF_VIEW_FOLD_PASSES) {
        logger.error('DEFECT: the out-of-view fold did not converge within its passes; placeholders cover the rest', { passes: pass, throughSeq }, agentId);
        budget.deadline = Date.now();
      }
      await foldOutOfView(agentId, contextWindow, throughSeq, budget);
      assembled = await assemble();
    }
    return assembled;
  } finally {
    opts.abortSignal?.removeEventListener('abort', onCaller);
    releaseAbortable(agentId, stop);
  }
}

/** Fold what is owed through `throughSeq` within the turn's patience (each writer once per turn), then cover the
 *  rest with placeholders. A turn never waits on another compaction's lock: if one holds it, the rows are labelled
 *  now beside it, and that job's summaries take them out of the notes when they land. */
async function foldOutOfView(agentId: string, contextWindow: number, throughSeq: number, budget: TurnBudget): Promise<void> {
  const bound = boundedSignal(budget.deadline, budget.stop);
  let failedWriter: string | null = null;
  let noWriter = false;
  let covered = 0;
  const backlog = catchUpOwns(agentId, throughSeq);
  try {
    const ran = await withLock(`compact:${agentId}`, async () => {
      if (backlog) noWriter = pickWriter(agentId) === null;
      while (!backlog && !bound.signal.aborted) {
        const owed = owedThrough(agentId, throughSeq).rows;
        if (owed === 0) break;
        const eligible = eligibleSummaryWriters(ownModel(agentId), agentId);
        if (eligible.length === 0) { noWriter = true; break; }
        const writer = eligible.find((w) => !budget.tried.has(w));
        if (!writer) break;
        budget.tried.add(writer);
        const passStart = Date.now();
        const r = await leavingViewPass(agentId, writer, contextWindow, { cause: 'out-of-view', throughSeq, rowsLeaving: owed }, { abortSignal: bound.signal });
        // A span that failed its check goes to no other writer this turn.
        if (summaryCheckRefusedSince(agentId, passStart)) break;
        if (r.leafCreated === 0 && bound.signal.reason === FOLD_IN_TURN_LIMIT) markWaiting(EVERY_AGENT, writer, '', 'not-answering');
        else if (r.leafCreated === 0 && abortBlamesWriter(bound.signal)) failedWriter = writer;
      }
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      return true;
    }, { ifBusy: 'skip' }).catch((err: unknown) => {
      logger.error('The out-of-view fold failed; placeholders cover its rows', { error: err instanceof Error ? err.message : String(err) }, agentId);
      return false;
    });
    if (ran !== true) {
      covered += writeUncondensedPlaceholders(agentId, throughSeq);
      if (ran === undefined) logger.info('Another compaction holds the lock: the turn labels the rows leaving view and the fold happens after', { throughSeq, covered }, agentId);
    }
  } finally {
    bound.done();
  }
  if (backlog && covered > 0) beginCatchUp(agentId, covered);
  if (covered > 0 && budget.stop?.aborted !== true && (failedWriter !== null || noWriter)) {
    const waits = spanWaitsForAWriter(agentId);
    const none = noWriter && !waits && summaryWriterCandidates(ownModel(agentId), agentId).length === 0;
    reportCompactionDefect(agentId, none ? 'summary_writer_unresolvable' : 'summary_writer_unavailable', {
      modelId: failedWriter ?? undefined, waiting: waits,
      detail: `${covered} row(s) left the live view while no summary writer answered; placeholder notes stand in for them`,
    }, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
  }
}
