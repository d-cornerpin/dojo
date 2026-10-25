// ════════════════════════════════════════════════════════════════════════════════════════
// t149 F4 — A SUMMARY WRITER THAT FAILS, OR CANNOT HOLD THE INPUT, HANDS THE SPAN ON AT ONCE.
//
// A compaction pass that wrote nothing because its writer failed (`summary-writer-health.ts` has
// already passed that writer over) hands the same span to the next eligible writer in the SAME pass.
// Before this the pass ended with nothing written and armed the 15-minute low-yield brake
// (`compaction-brakes.ts`), so compaction sat stalled behind a dead cheapest writer while another
// writer was answering. Round 4: the same when the writer is fine but a row
// is more than ITS window can hold (`left.tooBig`): the next eligible writer that holds that input
// takes it. The writer is chosen by the real input. A pass the owner's Stop ended hands nothing on.
// The out-of-view door (`out-of-view-fold.ts`) walks the writers itself, one pass per writer, and so does
// condensation (t269 round 2: `condense-until-fits.ts` hands a pair to each writer that has not refused it).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isStopFenced } from '../agent/shared-state.js';
import { eligibleSummaryWriters, writerPassedOver } from './summary-writer-health.js';

const logger = createLogger('leaf-writer-fallback');

/** What a pass left behind for want of room: set by the pass when a row was more than its writer holds. */
export interface LeftBehind { tooBig: boolean; /** the first row the passes looked at: where the covering of stranded rows starts */ fromSeq?: number }

const configuredModel = (agentId: string): string | undefined =>
  (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;

/** Run `pass(writer, left)` with `firstWriter`, then with each next eligible writer while the last one failed or left a row it could not hold. */
export async function leafWithWriterFallback(
  agentId: string, firstWriter: string, pass: (writer: string, left: LeftBehind) => Promise<number>, abortSignal?: AbortSignal,
  /** After the LAST writer: cover the rows no writer took (the platform's "not yet condensed" notes). */
  finish?: (left: LeftBehind) => Promise<void>,
): Promise<{ leafCreated: number; writer: string }> {
  const tried = new Set<string>();
  const left: LeftBehind = { tooBig: false };
  let writer = firstWriter;
  let leafCreated = 0;
  for (;;) {
    tried.add(writer);
    left.tooBig = false;
    leafCreated += await pass(writer, left);
    const next = abortSignal?.aborted || isStopFenced(agentId) || !(left.tooBig || writerPassedOver(writer, agentId)) ? undefined
      : eligibleSummaryWriters(configuredModel(agentId), agentId).find((w) => !tried.has(w));
    if (!next) { await finish?.(left); return { leafCreated, writer }; }
    logger.info('The summary writer failed or could not hold a row; the next eligible writer takes the span at once', { from: writer, next }, agentId);
    writer = next;
  }
}
