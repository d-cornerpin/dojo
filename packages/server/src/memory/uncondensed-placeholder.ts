// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 items 3, 5, 6) — A ROW THE VIEW DROPPED IS NEVER UNREPRESENTED.
//
// When no summary writer answers in time (or a backlog is too large to fold inside one owner
// turn), the rows the view dropped get a PLACEHOLDER instead of a summary: a deterministic note,
// built from stored columns only — how many messages, from which kind of conversation, over what
// absolute time range — saying they are not yet condensed and that the originals are kept and
// searchable. No model writes it, and no outside text is copied into it: the conversation is named
// from a fixed vocabulary of channel words, never by a sender's name or a message's words.
//
// A placeholder is a summary row of kind `UNCONDENSED_KIND` (`uncondensed-head.ts`) — never known by
// its text — one per leaf chunk. Condensation never merges one. When a writer answers again the
// placeholder's own row is REWRITTEN in place with a real summary of exactly its rows — the links
// never move — in the background, and the 15-minute low-yield brake does not hold it back.
//
// Round 4 (re-review 3): placeholders are written UNDER the per-agent compaction lock (their caller
// holds it); a real leaf summary landing on a placeholder's rows takes them out of it
// (`uncondensed-head.ts`), so no row ever carries two notes; and placeholder rows reach the vault
// archive exactly as summarised rows do (`archiveBeforeCovering`, the one shared step).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { getMessagesOutsideFreshTail } from './store.js';
import { createLeafSummary, deleteSummary, getCompactedMessageIds, getSummarySourceMessages, updateSummaryContent } from './dag.js';
import { UNCONDENSED_KIND, placeholderText, supersedeUncondensedPlaceholders } from './uncondensed-head.js';
import {
  archiveBeforeCovering, buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, rebuildContextItems,
  NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { generateSummary } from './summarize.js';
import { summaryTargetTokens } from './summary-target.js';
import { isMarkedUnwritable, recordRefusal, writersLeft } from './unwritable-span.js';
import { KEPT_WHOLE_KIND, keptRowHandle } from './kept-row-view.js';
import { toolResultView, POINTER_VIEW_CHARS } from './tool-result-view.js';
import { refreshEmbedding } from './embeddings.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { abortBlamesWriter, eligibleSummaryWriters } from './summary-writer-health.js';
import { noteCompactionRecovered, reportCompactionDefect } from './compaction-defect.js';
import { backgroundDrains } from '../agent/shared-state.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-uncondensed-placeholder');

/** Unsummarised rows of this session at or below `throughSeq` (the fold's own reader). */
export function owedThrough(agentId: string, throughSeq: number): Message[] {
  const compacted = getCompactedMessageIds(agentId);
  return getMessagesOutsideFreshTail(agentId, 1)
    .filter((m) => !compacted.has(m.id) && (m.rowid ?? Number.POSITIVE_INFINITY) <= throughSeq);
}

/** Cover every still-unsummarised row at or below `throughSeq` with placeholders, one per leaf
 *  chunk. The CALLER HOLDS the per-agent compaction lock. Synchronous and model-free; re-reads what
 *  is owed, so it never covers a row twice. The rows are archived to the vault first, and a failed
 *  archive refuses the cover, as it does for a summary. Returns rows covered. */
export function writeUncondensedPlaceholders(agentId: string, throughSeq: number): number {
  const owed = owedThrough(agentId, throughSeq);
  if (owed.length === 0) return 0;
  if (!archiveBeforeCovering(agentId, owed)) return 0;
  for (const chunk of chunkMessages(owed, getLeafChunkTokens())) {
    if (chunk.length > 0) placeholderFor(agentId, chunk);
  }
  rebuildContextItems(agentId);
  logger.warn('Rows left the live view with no summary written in time; placeholders stand in until one is', {
    rows: owed.length, throughSeq,
  }, agentId);
  return owed.length;
}

/** One placeholder note over exactly `rows` (the ONE writer of the kind). Returns its id. */
function placeholderFor(agentId: string, rows: readonly Message[]): string {
  const text = placeholderText(rows);
  return getDb().transaction(() => {
    const note = createLeafSummary(agentId, text, estimateTokens(text), rows.map((m) => m.id), rows[0].createdAt, rows[rows.length - 1].createdAt);
    getDb().prepare('UPDATE summaries SET kind = ? WHERE id = ?').run(UNCONDENSED_KIND, note.id);
    return note.id;
  })();
}

/** t269 fix round 1 (I1): the note for ONE row no writer could summarise — the row as summary input shows it
 *  (its tag; credential and technique bodies scrubbed), as the live view's kept-row pointer when long. */
function keepRowWhole(agentId: string, noteId: string, row: Message): void {
  const shown = buildLeafSummaryInput([row], Number.MAX_SAFE_INTEGER);
  const text = shown.length > POINTER_VIEW_CHARS ? toolResultView(shown, keptRowHandle(row.id), POINTER_VIEW_CHARS) : shown;
  getDb().prepare('UPDATE summaries SET kind = ?, content = ?, token_count = ? WHERE id = ?').run(KEPT_WHOLE_KIND, text, estimateTokens(text), noteId);
  logger.warn('No summary writer could summarise this row whole; it is kept whole behind its pointer until it changes', { messageId: row.id, chars: row.content.length }, agentId);
}

/** A kept-whole row that is no longer refused by every candidate writer (its content changed, the owner's
 *  writer setting changed, or a new writer can be asked) becomes a placeholder again, so it is tried again. */
function releaseChangedKeptRows(agentId: string): number {
  const notes = getDb().prepare('SELECT id FROM summaries WHERE agent_id = ? AND kind = ?').all(agentId, KEPT_WHOLE_KIND) as Array<{ id: string }>;
  let released = 0;
  for (const { id } of notes) {
    const rows = getSummarySourceMessages(id);
    if (rows.length > 0 && isMarkedUnwritable(agentId, rows.map((m) => ({ id: m.id, content: m.content })))) continue;
    if (rows.length === 0) { deleteSummary(id); continue; }
    const text = placeholderText(rows);
    getDb().prepare('UPDATE summaries SET kind = ?, content = ?, token_count = ? WHERE id = ?').run(UNCONDENSED_KIND, text, estimateTokens(text), id);
    released++;
  }
  return released;
}

export function hasUncondensedPlaceholders(agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM summaries WHERE agent_id = ? AND kind = ? LIMIT 1').get(agentId, UNCONDENSED_KIND);
}

function configuredModel(agentId: string): string | undefined {
  return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;
}

/** Is this row also covered by a REAL summary (a fold that landed beside a placeholder)? */
function coveredElsewhere(messageId: string, placeholderId: string): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id
      WHERE sm.message_id = ? AND sm.summary_id != ? AND s.kind != ? LIMIT 1`,
  ).get(messageId, placeholderId, UNCONDENSED_KIND);
}

/**
 * Replace placeholders with real summaries of exactly their rows, oldest first, trying each writer in
 * the owner's order once per note — only writers that are answering (round 6: a failed writer waits
 * for something to change, `summary-writer-health.ts`). Round 5: no clock and no per-run cap; a writer is ended only by its own
 * transport's patience, Stop, or the turn setting this aside. A pass stops at the first note no
 * writer could replace, and the next gate tries again. Under the per-agent compaction lock (waiting
 * for one running); never consults the low-yield brake. When none remain, the compaction-failing
 * incident is over. Returns how many were replaced (or dropped because a real fold covered them).
 */
export async function replaceUncondensedPlaceholders(
  agentId: string, opts: { abortSignal?: AbortSignal } = {},
): Promise<number> {
  return (await withLock(`compact:${agentId}`, () => replaceUnderLock(agentId, opts), { ifBusy: 'wait' })) ?? 0;
}

async function replaceUnderLock(agentId: string, opts: { abortSignal?: AbortSignal }): Promise<number> {
  const queue = (getDb().prepare(
    'SELECT id FROM summaries WHERE agent_id = ? AND kind = ? ORDER BY earliest_at ASC, id ASC',
  ).all(agentId, UNCONDENSED_KIND) as Array<{ id: string }>).map((r) => r.id);
  const preferred = configuredModel(agentId);
  let replaced = 0;
  let failedWriter: string | null = null;
  let stoppedByOwner = false;
  let checkFailed = false;
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (opts.abortSignal?.aborted) break;
    const all = getSummarySourceMessages(id);
    const source = all.filter((m) => !coveredElsewhere(m.id, id));
    if (source.length === 0) {
      deleteSummary(id);
      replaced++;
      continue;
    }
    // Rows a real summary already covers leave this placeholder before it is summarised.
    if (source.length < all.length) supersedeUncondensedPlaceholders(agentId, all.filter((m) => !source.includes(m)).map((m) => m.id));
    const content = buildLeafSummaryInput(source);
    let done = content.trim().length === 0;
    if (done) updateSummaryContent(id, NO_CONVERSATION_PLACEHOLDER, estimateTokens(NO_CONVERSATION_PLACEHOLDER));
    const span = source.map((m) => ({ id: m.id, content: m.content }));
    const left = new Set(writersLeft(agentId, span));
    for (const writer of eligibleSummaryWriters(preferred, agentId)) {
      if (done || opts.abortSignal?.aborted) break;
      if (!left.has(writer)) continue;   // t269 round 2 (N1): it already said it cannot write this span whole
      const summary = await generateSummary({ content, depth: 0, targetTokens: summaryTargetTokens(content), agentId, modelId: writer, abortSignal: opts.abortSignal, spanIds: source.map((m) => m.id) });
      if (!summary.ok) {
        if (summary.stopped) { stoppedByOwner = true; break; }   // the owner's Stop: not the writer's failure, and no next writer
        if (summary.checkFailed) { checkFailed = true; break; }  // v3.5: a verdict on this span — no other writer, left as it is
        if (summary.tooBig) { recordRefusal(agentId, writer, span); continue; }   // t149 F4: more than it holds (or cut twice); the next may hold it
        if (abortBlamesWriter(opts.abortSignal)) failedWriter = writer;
        continue;
      }
      const text = annotateSummaryObligations(summary.text, agentId);
      updateSummaryContent(id, text, text === summary.text ? summary.tokenCount : estimateTokens(text));   // now a leaf
      refreshEmbedding('summary', id, agentId, text);   // the real text is knowledge; the note never was
      done = true;
    }
    if (checkFailed) { checkFailed = false; continue; }   // v3.5 ruling: each span is its own — the next placeholder is not held
    // t269 fix rounds 1–2 (I1, N1): EVERY candidate writer said it cannot write this span whole (one that was
    // out was not asked, so it is not counted). Split it, down to single rows; a single row is kept whole behind
    // its pointer (`unwritable-span.ts`). Each half is tried in this same pass, so a span of n rows costs at most
    // 2n − 1 attempts per writer, once, until something changes.
    if (!done && !stoppedByOwner && isMarkedUnwritable(agentId, span)) {
      if (source.length > 1) {
        const later = source.slice(Math.ceil(source.length / 2));
        supersedeUncondensedPlaceholders(agentId, later.map((m) => m.id));
        queue.unshift(id, placeholderFor(agentId, later));
      } else {
        keepRowWhole(agentId, id, source[0]);
        replaced++;
      }
      continue;
    }
    if (!done || stoppedByOwner) break;
    replaced++;
  }
  if (replaced > 0) rebuildContextItems(agentId);
  if (!hasUncondensedPlaceholders(agentId)) {
    noteCompactionRecovered(agentId, 0);
  } else if (failedWriter) {
    reportCompactionDefect(agentId, 'summary_writer_unavailable',
      { modelId: failedWriter, detail: 'placeholder notes could not yet be replaced by summaries' },
      { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
  }
  logger.info('Placeholder replacement pass', { replaced, remaining: hasUncondensedPlaceholders(agentId) }, agentId);
  return replaced;
}

// STRIP (t140 round 7, re-review I2'): the registry of preemptible background compactions (round 4)
// and `preemptBackgroundCompaction`. A turn never waits on another compaction's lock (round 6), so
// setting a background job aside only threw its working summary away and labelled anyway. A running
// background summary is left alone; its real summaries land and take their rows out of any note.

/** THE GATE'S LAUNCHER: one background replacement per agent (sharing the routine condense's
 *  one-in-flight slot), only when a placeholder exists and some writer is answering. */
export function replacePlaceholdersInBackground(agentId: string): boolean {
  try {
    releaseChangedKeptRows(agentId);   // t269 fix round 1: a kept-whole row that changed is a placeholder again
    if (backgroundDrains.has(agentId) || !hasUncondensedPlaceholders(agentId)) return false;
    if (eligibleSummaryWriters(configuredModel(agentId), agentId).length === 0) return false;   // none answering: no dial
  } catch {
    return false;   // a read that failed starts nothing; the gate never fails a turn over this
  }
  backgroundDrains.add(agentId);
  // Round 5: no clock of its own — a writer slower than the turn's patience finishes here. Round 7:
  // no turn sets it aside either (a turn that will not wait labels beside it instead).
  replaceUncondensedPlaceholders(agentId)
    .catch((err) => logger.warn('Placeholder replacement failed', { error: err instanceof Error ? err.message : String(err) }, agentId))
    .finally(() => { backgroundDrains.delete(agentId); });
  return true;
}
