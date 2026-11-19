// The transports' shared catch-side bookkeeping for a failed model call, kept apart from
// `caller-stop.ts` so that module's caller-stopped question stays import-free.

import { createLogger } from '../logger.js';
import { recordProviderError } from '../gateway/routes/services.js';
import { noteProviderFailure } from '../providers/billing-breaker.js';
import type { ProviderErrorFacts } from './provider-error.js';
import { callerStopped, stopReason } from './caller-stop.js';

const logger = createLogger('model');
const summarizeLog = createLogger('memory-summarize');   // the same tag the summary call's own lines carry

/** A genuine failure marks the provider unhealthy and logs `<what> failed`; best-effort utility
 *  calls WARN, others ERROR. A call its caller stopped marks nothing: a stop is not a failure. */
export function settleFailedCall(
  what: string, message: string, detail: Record<string, unknown>,
  o: { providerId: string; agentId: string; signal?: AbortSignal; bestEffort?: boolean; facts?: ProviderErrorFacts },
): void {
  if (o.signal && callerStopped(o.signal)) {
    logger.info(`${what} stopped by its caller (${stopReason(o.signal)}): ${message}`, detail, o.agentId);
    return;
  }
  recordProviderError(o.providerId);
  noteProviderFailure(o.providerId, message, o.agentId, o.facts);   // permanent refusals open the breaker; passing ones are ignored
  logger[o.bestEffort ? 'warn' : 'error'](`${what} failed: ${message}`, { ...detail, bestEffort: o.bestEffort ?? false }, o.agentId);
}

/** Logs a failed summary call; a caller-stopped one is the caller's decision, not the writer's failure. The breaker hears of the failure in `settleFailedCall`, once. */
export function noteSummaryCallFailed(o: {
  modelId: string; message: string; agentId: string;
  depth: number; targetTokens: number; abortSignal?: AbortSignal;
}): void {
  const { modelId, message, agentId, depth, targetTokens, abortSignal } = o;
  if (abortSignal && callerStopped(abortSignal)) {
    summarizeLog.info(`Summary call stopped by its caller (${stopReason(abortSignal)})`, { modelId, depth, targetTokens }, agentId);
    return;
  }
  summarizeLog.error('SUMMARY_REFUSED summarization model call failed', { error: message, depth, targetTokens }, agentId);
}
