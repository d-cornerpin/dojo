// ════════════════════════════════════════════════════════════════════════════
// t220 — A CALL THE CALLER STOPPED IS THE CALLER'S DECISION, NOT THE PROVIDER'S FAILURE.
//
// A caller hands a model call an abort signal and may end it for its own reasons: the owner's
// Stop, a turn whose patience ran out, a teardown. The call then throws, and each transport's
// generic catch used to treat that throw as the provider failing: it marked a healthy provider
// unhealthy and logged an ERROR "call failed" for a call the provider never failed.
//
// The question "did the call's own abort signal end it?" lives here, once, with no imports so any
// module (the summary writer's bookkeeping included) can ask it. Transports settle a failed call
// through `settleFailedCall` (failed-call.ts), which asks it.
// This is deliberately NOT the stream watchdog's question (`streamWasCutByWatchdog`: did OUR
// timer cut the stream), which the transports answer first and which is a real provider
// failure; a watchdog trip on a signal nobody aborted never reaches here as a stop.
// ════════════════════════════════════════════════════════════════════════════

/** Was this call ended by the signal its caller gave it? Whatever the abort's reason was. */
export function callerStopped(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** The abort's reason in words, for a log line. */
export function stopReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === 'string' ? r : r instanceof Error ? r.name : 'no reason given';
}
