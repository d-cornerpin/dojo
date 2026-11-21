// Merges an agent's top-level notes, each note once at its depth: notes of one depth (a conversation's own first,
// `subjectBatches`) become one parent at depth + 1, until no depth holds two notes the writer has not refused. A
// pair refused for its own sake (too long for the keep rule, or failed its check) rests BOTH its notes for that writer
// (`writer.ts`), so a note is offered once at a depth. A note left alone stays whole, shown or named.
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

/** Notes per merge: a pair may keep about 0.4 of its input under the keep rule, which real merges reach. */
const BATCH = 2;

export type RefusedStage = 'summary_writer_unavailable' | 'summariser_refused' | 'summariser_threw';

/** `stage` is set only when a run that merged nothing met a refusal, or a writer that could not answer; `rested`
 *  counts the notes this run rested on a refused pair. */
export interface MergeOutcome { created: number; tokensReclaimed: number; stage: RefusedStage | null; detail: string | null; rested: number }

const refusedBy = (writer: string, note: Summary): boolean => waiting(note.agentId, writer, spanKeyOf([note])) === 'cannot-hold';

/** The shallowest group of two or more top-level notes of one depth not yet tried: neither refused by `writer` nor
 *  in this run's `tried`, which bounds the run even if a mark could not be written. */
function nextBatch(agentId: string, writer: string, tried: ReadonlySet<string>): Summary[] | null {
  const depths = getDb().prepare('SELECT DISTINCT depth FROM summaries WHERE agent_id = ? AND id NOT IN (SELECT parent_id FROM summary_parents) ORDER BY depth')
    .all(agentId) as Array<{ depth: number }>;
  for (const { depth } of depths) {
    const peers = getLeafSummariesNotCondensed(agentId, depth).filter((s) => s.kind !== UNCONDENSED_KIND && s.kind !== KEPT_WHOLE_KIND);
    const batch = subjectBatches(peers, BATCH, (s) => !tried.has(s.id) && !refusedBy(writer, s)).find((b) => b.length >= 2);
    if (batch) return batch;
  }
  return null;
}

/** Merge until no depth holds two untried notes. A verdict on a pair rests both its notes and the run goes on; a
 *  refusal about the writer ends the run with no note marked, as do the owner's Stop and an abort. */
export async function mergeUntriedNotes(agentId: string, writer: string, abortSignal?: AbortSignal): Promise<MergeOutcome> {
  const out: MergeOutcome = { created: 0, tokensReclaimed: 0, stage: null, detail: null, rested: 0 };
  const tried = new Set<string>();
  let refusal: string | null = null;   // a writer's refusal of a batch: told when the run merged nothing
  const ended = (stage: RefusedStage, detail: string): MergeOutcome => (out.created > 0 ? out : { ...out, stage, detail });
  for (let batch = nextBatch(agentId, writer, tried); batch && !abortSignal?.aborted; batch = nextBatch(agentId, writer, tried)) {
    if (summaryWriterUnavailable(agentId, writer)) return ended('summary_writer_unavailable', writer);
    const content = condensedSummaryInput(batch);
    const depth = batch[0].depth + 1;
    let summary: SummaryResult;
    try {
      summary = await generateSummary({
        content, depth, agentId, modelId: writer, abortSignal, spanIds: batch.map((s) => `summary:${s.id}`),
        targetTokens: mergeTargetTokens(batch.map((s) => s.content).join('\n\n'), batch.length, modelCharsPerToken(writer)),
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
    } else if ((summary.tooBig && !summary.noRoom && !summary.forNow) || summary.checkFailed) {
      for (const s of batch) { tried.add(s.id); markWaiting(agentId, writer, spanKeyOf([s]), 'cannot-hold'); }   // a verdict on the pair
      out.rested += batch.length;
    } else {   // about the writer and the moment (no memory free, not answering, an empty answer): no note is marked
      logger.warn('SUMMARY_REFUSED a merge was left unmerged', { depth, parentCount: batch.length, reason: summary.reason }, agentId);
      refusal = summary.reason;
      break;
    }
    await new Promise<void>((resolve) => { setImmediate(resolve); });   // the reads are synchronous: the loop is served between merges
  }
  return refusal === null ? out : ended('summariser_refused', refusal);
}
