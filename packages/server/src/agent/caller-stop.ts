// A caller-stop is not a provider failure, and not the watchdog's cut; asked here once, with no imports.

export function callerStopped(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function stopReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  return typeof r === 'string' ? r : r instanceof Error ? r.name : 'no reason given';
}
