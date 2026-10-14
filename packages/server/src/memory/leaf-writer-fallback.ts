// ════════════════════════════════════════════════════════════════════════════════════════
// t149 F4 — A SUMMARY WRITER THAT FAILS IS PASSED OVER ON ITS FIRST FAILURE, AND THE NEXT ONE TRIES AT ONCE.
//
// A compaction pass that wrote nothing because its writer failed (`summary-writer-health.ts` has
// already passed that writer over) hands the same span to the next eligible writer in the SAME pass.
// Before this the pass ended with nothing written and armed the 15-minute low-yield brake
// (`compaction-brakes.ts`), so compaction sat stalled behind a dead cheapest writer while another
// writer was answering. A pass whose writer did not fail (nothing to fold, a stop) ends as it did.
// The out-of-view door (`out-of-view-fold.ts`) walks the writers itself, one pass per writer.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { eligibleSummaryWriters, writerPassedOver } from './summary-writer-health.js';

const logger = createLogger('leaf-writer-fallback');

/** Run `pass(writer)` with `firstWriter`, then with each next eligible writer while the last one failed. */
export async function leafWithWriterFallback(
  agentId: string, firstWriter: string, pass: (writer: string) => Promise<number>, abortSignal?: AbortSignal,
): Promise<{ leafCreated: number; writer: string }> {
  const tried = new Set<string>();
  let writer = firstWriter;
  for (;;) {
    tried.add(writer);
    const leafCreated = await pass(writer);
    if (leafCreated > 0 || abortSignal?.aborted || !writerPassedOver(writer, agentId)) return { leafCreated, writer };
    const configured = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;
    const next = eligibleSummaryWriters(configured, agentId).find((w) => !tried.has(w));
    if (!next) return { leafCreated, writer };
    logger.info('The summary writer failed; the next eligible writer takes the same span at once', { failed: writer, next }, agentId);
    writer = next;
  }
}
