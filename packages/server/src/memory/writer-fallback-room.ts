// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268 fix round 2, ORCHESTRATOR RULING after the owner's of 2026-10-24, "The agents model.") — A FALLBACK
// SUMMARY ON THE DOJO'S WRITER IS SIZED TO THE MEMORY FREE WHEN IT RUNS.
//
// Each agent's own model writes its summaries; the Dojo's small writer writes one only when that model cannot be
// reached. Then no room is reserved for it (`services/dojo-working-memory.ts writerReservedWindowTokens`), so the
// call may use only what is free NOW (`agent/local-model-fit.ts freeWriterWindowTokens`): a span whose window would
// not fit is refused as too big — never dialled, nothing recorded against the writer — and the caller halves it,
// the path every caller already takes for a writer that cannot hold a span. When summaries are ASSIGNED to the
// writer its room is reserved, and nothing here refuses.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { standardModelRowId } from '../services/local-standard.js';
import { writerAssignedSummaries } from '../services/dojo-working-memory.js';
import { writerCharsPerToken } from '../services/token-density.js';
import { utilityDial, utilityNumCtx, utilityOutputCap } from '../agent/utility-dial.js';
import type { SummaryResult } from './summarize.js';

const logger = createLogger('writer-fallback-room');

export async function refuseFallbackOverFreeMemory(
  modelId: string, systemPrompt: string, content: string, targetTokens: number, agentId: string,
): Promise<SummaryResult | null> {
  if (modelId !== standardModelRowId('writer') || writerAssignedSummaries()) return null;
  const { freeWriterWindowTokens } = await import('../agent/local-model-fit.js');
  const free = await freeWriterWindowTokens();
  if (free === null) return null;
  const need = utilityNumCtx({ inputChars: systemPrompt.length + content.length, charsPerToken: writerCharsPerToken(),
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, targetTokens), configuredNumCtx: null });
  if (need <= free) return null;
  logger.warn('SUMMARY_REFUSED a fallback summary on the Dojo\'s writer needs more window than the memory free now holds; the span is halved', { need, free }, agentId);
  return { ok: false, reason: 'the memory free now cannot hold this span for the Dojo\'s writer', tooBig: true };
}
