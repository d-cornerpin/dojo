// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268 fix round 2, ORCHESTRATOR RULING after the owner's of 2026-10-24, "The agents model.") — A FALLBACK
// SUMMARY ON THE DOJO'S WRITER IS SIZED TO THE MEMORY FREE WHEN IT RUNS.
//
// Each agent's own model writes its summaries; the Dojo's small writer writes one only when that model cannot be
// reached. Then no room is reserved for it (`services/dojo-working-memory.ts writerReservedWindowTokens`), so the
// call may use only what is free NOW (`agent/local-model-fit.ts freeWriterWindowTokens`). Never dialled past it,
// and nothing is recorded against the writer:
//   · a span larger than what is free, while a smaller one would fit, is refused as too big and the caller halves
//     it — the path every caller already takes for a writer that cannot hold a span;
//   · fix rounds 4-5 (N-B, rulings): when not even a summary fits (a 16 GB box, always; a 32 GB box beside a large
//     loaded model, sometimes) the writer cannot run now — `noRoom`: nothing is halved, and the writer is passed
//     over for this agent until its own model is reachable again (`writer-no-room.ts`). Nothing comes after it in
//     the order, so the span waits, rows whole, for the agent's own model.
// When summaries are ASSIGNED to the writer its room is reserved, and nothing here refuses.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { standardModelRowId } from '../services/local-standard.js';
import { writerAssignedSummaries } from '../services/dojo-working-memory.js';
import { writerCharsPerToken } from '../services/token-density.js';
import { utilityDial, utilityNumCtx, utilityOutputCap } from '../agent/utility-dial.js';
import { noteWriterHadNoRoom, writerHadNoRoom } from './writer-no-room.js';
import type { SummaryResult } from './summarize.js';

const logger = createLogger('writer-fallback-room');
const NO_ROOM: SummaryResult = { ok: false, reason: 'the memory free now cannot hold a summary on the Dojo\'s writer', tooBig: true, noRoom: true };

export async function refuseFallbackOverFreeMemory(
  modelId: string, systemPrompt: string, content: string, targetTokens: number, agentId: string,
): Promise<SummaryResult | null> {
  if (modelId !== standardModelRowId('writer') || writerAssignedSummaries()) return null;
  if (writerHadNoRoom(agentId)) return NO_ROOM;   // already found with no room for this agent: nothing is read again
  const { freeWriterWindowTokens } = await import('../agent/local-model-fit.js');
  const free = await freeWriterWindowTokens();
  if (free === null) return null;
  const windowFor = (inputChars: number): number => utilityNumCtx({ inputChars, charsPerToken: writerCharsPerToken(),
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, targetTokens), configuredNumCtx: null });
  const need = windowFor(systemPrompt.length + content.length);
  if (need <= free) return null;
  if (windowFor(systemPrompt.length) > free) {
    noteWriterHadNoRoom(agentId);
    logger.warn('SUMMARY_REFUSED the memory free now cannot hold any summary on the Dojo\'s writer; the span waits, rows whole', { need, free }, agentId);
    return NO_ROOM;
  }
  logger.warn('SUMMARY_REFUSED a fallback summary on the Dojo\'s writer needs more window than the memory free now holds; the span is halved', { need, free }, agentId);
  return { ok: false, reason: 'the memory free now cannot hold this span for the Dojo\'s writer', tooBig: true };
}
