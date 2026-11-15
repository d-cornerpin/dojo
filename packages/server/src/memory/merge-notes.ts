// Merges an agent's top-level notes, each note once at its depth: notes of one depth (a conversation's own first,
// `subjectBatches`) become one parent at depth + 1, until no depth holds two notes the writer has not refused. A
// merge the keep rule refuses (`summary-whole.ts`) marks each of its notes refused for that writer (`writer.ts`), so
// no note is offered to it twice. A note alone at its depth stays whole; the summaries lane shows it or names it.
// Merges go to the pass's own writer only.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { createCondensedSummary, getLeafSummariesNotCondensed, type Summary } from './dag.js';
import { UNCONDENSED_KIND } from './uncondensed-head.js';
import { KEPT_WHOLE_KIND } from './kept-row-view.js';
import { generateSummary, condensedSummaryInput, type SummaryResult } from './summarize.js';
import { mergeTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { markWaiting, spanKeyOf, waiting } from './writer.js';
import { subjectBatches } from './summary-subject.js';
import { summaryWriterUnavailable } from './compaction-brakes.js';

const logger = createLogger('merge-notes');

/** Notes per merge: a conversation's notes are cut oldest first into groups of this size. */
const BATCH = 4;

export type RefusedStage = 'summary_writer_unavailable' | 'summariser_refused' | 'summariser_threw';

/** `stage` is set only when a run that merged nothing ended on a refusal that names no note. */
export interface MergeOutcome { created: number; tokensReclaimed: number; stage: RefusedStage | null; detail: string | null }

const refusedBy = (writer: string, note: Summary): boolean => waiting(note.agentId, writer, spanKeyOf([note])) === 'cannot-hold';

/** The shallowest group of two or more top-level notes of one depth that `writer` has not refused. */
function nextBatch(agentId: string, writer: string): Summary[] | null {
  const depths = getDb().prepare('SELECT DISTINCT depth FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT parent_id FROM summary_parents) ORDER BY depth')
    .all(agentId) as Array<{ depth: number }>;
  for (const { depth } of depths) {
    const peers = getLeafSummariesNotCondensed(agentId, depth)
      .filter((s) => s.kind !== UNCONDENSED_KIND && s.kind !== KEPT_WHOLE_KIND && !refusedBy(writer, s));
    const batch = subjectBatches(peers, BATCH).find((b) => b.length >= 2);
    if (batch) return batch;
  }
  return null;
}

/** Merge until no depth holds two untried notes. A run ends early on the owner's Stop, an abort, or a refusal that
 *  names no note (the pass outcome tells it; the next leaf fold tries again). */
export async function mergeUntriedNotes(agentId: string, writer: string, abortSignal?: AbortSignal): Promise<MergeOutcome> {
  const out: MergeOutcome = { created: 0, tokensReclaimed: 0, stage: null, detail: null };
  const ended = (stage: RefusedStage, detail: string): MergeOutcome => (out.created > 0 ? out : { ...out, stage, detail });
  for (let batch = nextBatch(agentId, writer); batch && !abortSignal?.aborted; batch = nextBatch(agentId, writer)) {
    if (summaryWriterUnavailable(agentId, writer)) return ended('summary_writer_unavailable', writer);
    const content = condensedSummaryInput(batch);
    const depth = batch[0].depth + 1;
    let summary: SummaryResult;
    try {
      summary = await generateSummary({
        content, depth, agentId, modelId: writer, abortSignal, spanIds: batch.map((s) => `summary:${s.id}`),
        targetTokens: mergeTargetTokens(content, batch.length, modelCharsPerToken(writer)),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('Failed to create condensed summary', { depth, parentCount: batch.length, error: detail }, agentId);
      return ended('summariser_threw', detail);
    }
    if (summary.ok) {
      createCondensedSummary(agentId, summary.text, summary.tokenCount, batch.map((s) => s.id), depth,
        batch.reduce((a, s) => (s.earliestAt < a ? s.earliestAt : a), batch[0].earliestAt),
        batch.reduce((a, s) => (s.latestAt > a ? s.latestAt : a), batch[0].latestAt));
      out.created += 1;
      out.tokensReclaimed += Math.max(0, batch.reduce((t, s) => t + s.tokenCount, 0) - summary.tokenCount);
    } else if (summary.stopped) {
      return out;
    } else if (summary.tooBig && !summary.noRoom) {
      for (const s of batch) markWaiting(agentId, writer, spanKeyOf([s]), 'cannot-hold');
    } else {
      logger.warn('SUMMARY_REFUSED a merge was left unmerged', { depth, parentCount: batch.length, reason: summary.reason }, agentId);
      return ended('summariser_refused', summary.reason);
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });   // the reads are synchronous: the loop is served between merges
  }
  return out;
}
