// t220 — settle one failed model call. The "did its caller stop it?" question is `caller-stop.ts`'s;
// this is the transports' shared catch-side bookkeeping, kept apart so that question stays import-free.

import { createLogger } from '../logger.js';
import { recordProviderError } from '../gateway/routes/services.js';
import { noteSummaryWriterFailure } from '../providers/billing-breaker.js';
import type { ProviderErrorFacts } from './provider-error.js';
import { callerStopped, stopReason } from './caller-stop.js';

const logger = createLogger('model');
const summarizeLog = createLogger('memory-summarize');   // the tag the summary call's own lines have always carried

/**
 * A transport's generic catch: settle one failed call. A genuine failure marks the provider
 * unhealthy and logs `<what> failed` (WARN for best-effort utility calls, ERROR otherwise). A call
 * its caller stopped marks nothing and logs one INFO line naming the reason.
 */
export function settleFailedCall(
  what: string, message: string, detail: Record<string, unknown>,
  o: { providerId: string; agentId: string; signal?: AbortSignal; bestEffort?: boolean },
): void {
  if (o.signal && callerStopped(o.signal)) {
    logger.info(`${what} stopped by its caller (${stopReason(o.signal)}): ${message}`, detail, o.agentId);
    return;
  }
  recordProviderError(o.providerId);
  logger[o.bestEffort ? 'warn' : 'error'](`${what} failed: ${message}`, { ...detail, bestEffort: o.bestEffort ?? false }, o.agentId);
}

/**
 * A summary model call threw (`summarize.ts`'s catch). A call its caller stopped (the fold's patience,
 * Stop) is the caller's decision, not the writer's failure: one INFO line naming why, no breaker note.
 * Otherwise the provider's facts go to the billing breaker (a permanent wall opens it) and the failure
 * is logged at ERROR.
 */
export function noteSummaryCallFailed(o: {
  modelId: string; message: string; agentId: string; facts?: ProviderErrorFacts;
  depth: number; targetTokens: number; abortSignal?: AbortSignal;
}): void {
  const { modelId, message, agentId, depth, targetTokens, abortSignal } = o;
  if (abortSignal && callerStopped(abortSignal)) {
    summarizeLog.info(`Summary call stopped by its caller (${stopReason(abortSignal)})`, { modelId, depth, targetTokens }, agentId);
    return;
  }
  const permanent = noteSummaryWriterFailure(modelId, message, agentId, o.facts);
  summarizeLog.error('SUMMARY_REFUSED summarization model call failed', {
    error: message, depth, targetTokens, permanent: permanent ?? 'transient',
  }, agentId);
}
