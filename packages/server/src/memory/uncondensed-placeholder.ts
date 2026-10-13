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
  archiveBeforeCovering, buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, getLeafTargetTokens, rebuildContextItems,
  NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { generateSummary } from './summarize.js';
import { refreshEmbedding } from './embeddings.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { abortBlamesWriter, backgroundSummaryWriters, FOLD_PREEMPTED } from './summary-writer-health.js';
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
    if (chunk.length === 0) continue;
    const text = placeholderText(chunk);
    getDb().transaction(() => {
      const note = createLeafSummary(agentId, text, estimateTokens(text), chunk.map((m) => m.id), chunk[0].createdAt, chunk[chunk.length - 1].createdAt);
      getDb().prepare('UPDATE summaries SET kind = ? WHERE id = ?').run(UNCONDENSED_KIND, note.id);   // the ONE writer of the kind
    })();
  }
  rebuildContextItems(agentId);
  logger.warn('Rows left the live view with no summary written in time; placeholders stand in until one is', {
    rows: owed.length, throughSeq,
  }, agentId);
  return owed.length;
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
 * the owner's order once per note (`backgroundSummaryWriters`: only broken ones are passed over —
 * nobody waits here). Round 5: no clock and no per-run cap; a writer is ended only by its own
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
  const ids = getDb().prepare(
    'SELECT id FROM summaries WHERE agent_id = ? AND kind = ? ORDER BY earliest_at ASC, id ASC',
  ).all(agentId, UNCONDENSED_KIND) as Array<{ id: string }>;
  const preferred = configuredModel(agentId);
  let replaced = 0;
  let failedWriter: string | null = null;
  for (const { id } of ids) {
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
    for (const writer of backgroundSummaryWriters(preferred)) {
      if (done || opts.abortSignal?.aborted) break;
      const summary = await generateSummary({ content, depth: 0, targetTokens: getLeafTargetTokens(), agentId, modelId: writer, abortSignal: opts.abortSignal });
      if (!summary.ok) { if (abortBlamesWriter(opts.abortSignal)) failedWriter = writer; continue; }
      const text = annotateSummaryObligations(summary.text, agentId);
      updateSummaryContent(id, text, text === summary.text ? summary.tokenCount : estimateTokens(text));   // now a leaf
      refreshEmbedding('summary', id, agentId, text);   // the real text is knowledge; the note never was
      done = true;
    }
    if (!done) break;
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

// ── Round 4 (re-review 3 F1): ROUTINE BACKGROUND COMPACTIONS ARE PREEMPTIBLE BY THE TURN ─────────
// The gate's background pressure fold and this replacement register their abort here. When the turn's
// own out-of-view fold needs the compaction lock, it sets them aside (reason `FOLD_PREEMPTED`, never a
// writer failure) so it can write its summaries — or its placeholders — UNDER the lock in time.
const backgroundCompactions = new Map<string, AbortController>();
export function registerBackgroundCompaction(agentId: string, ctl: AbortController): void { backgroundCompactions.set(agentId, ctl); }
export function releaseBackgroundCompaction(agentId: string, ctl: AbortController): void {
  if (backgroundCompactions.get(agentId) === ctl) backgroundCompactions.delete(agentId);
}
export function preemptBackgroundCompaction(agentId: string): boolean {
  const ctl = backgroundCompactions.get(agentId);
  if (!ctl || ctl.signal.aborted) return false;
  ctl.abort(FOLD_PREEMPTED);
  logger.info('A routine background compaction was set aside for this turn\'s out-of-view fold', {}, agentId);
  return true;
}

/** THE GATE'S LAUNCHER: one background replacement per agent (sharing the routine condense's
 *  one-in-flight slot), only when a placeholder exists and some writer is not broken. */
export function replacePlaceholdersInBackground(agentId: string): boolean {
  try {
    if (backgroundDrains.has(agentId) || !hasUncondensedPlaceholders(agentId)) return false;
    if (backgroundSummaryWriters(configuredModel(agentId)).length === 0) return false;
  } catch {
    return false;   // a read that failed starts nothing; the gate never fails a turn over this
  }
  backgroundDrains.add(agentId);
  const ctl = new AbortController();
  registerBackgroundCompaction(agentId, ctl);
  // Round 5: no clock of its own — a writer slower than the turn's patience finishes here.
  replaceUncondensedPlaceholders(agentId, { abortSignal: ctl.signal })
    .catch((err) => logger.warn('Placeholder replacement failed', { error: err instanceof Error ? err.message : String(err) }, agentId))
    .finally(() => { releaseBackgroundCompaction(agentId, ctl); backgroundDrains.delete(agentId); });
  return true;
}
