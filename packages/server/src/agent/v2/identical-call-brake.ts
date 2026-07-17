// ════════════════════════════════════════
// Identical-call brake (2026-07-17)
//
// Observed live: the PM agent called tracker_get_status with the same wrong
// argument (a task TITLE where an id belongs) 189 times in one turn, each call
// failing identically, until the last-resort runaway invariant (201 tool
// calls) killed the loop. Every graduated defense missed: the not-found error
// did not converge the retry, the cross-turn failure ledger only arms on the
// NEXT turn, and the spinning nudge never fired. A floor model that gets the
// same error twice will pull the same lever forever.
//
// This is the deterministic mid-turn brake: track consecutive results per
// EXACT call signature (tool name + canonical args) within a turn;
//   - at WARN_AT identical failures, append a corrective notice to the result
//     telling the model to change the arguments or the approach;
//   - at REFUSE_AT, the engine stops executing the identical call entirely and
//     returns the notice as the result (no side effects, no provider cost).
// A success for the signature resets it, so legitimate poll-retry loops that
// eventually succeed are untouched. Distinct arguments are untouched.
// ════════════════════════════════════════

export const IDENTICAL_CALL_WARN_AT = 3;
export const IDENTICAL_CALL_REFUSE_AT = 6;

export interface RepeatEntry {
  failures: number;
  lastError: string;
}

export type RepeatCallState = Map<string, RepeatEntry>;

/** Canonical signature: tool name + stable-stringified args. */
export function identicalCallSignature(tool: string, args: unknown): string {
  let argsKey: string;
  try {
    const obj = (args ?? {}) as Record<string, unknown>;
    argsKey = JSON.stringify(obj, Object.keys(obj).sort());
  } catch {
    argsKey = String(args);
  }
  return `${tool}:${argsKey}`;
}

/**
 * Pre-execution check. Returns the refusal text when the identical call has
 * already failed REFUSE_AT times this turn (caller returns it as an error
 * result WITHOUT executing), else null.
 */
export function checkIdenticalCallRefusal(state: RepeatCallState, sig: string): string | null {
  const entry = state.get(sig);
  if (!entry || entry.failures < IDENTICAL_CALL_REFUSE_AT) return null;
  return (
    `[Engine: this exact tool call has failed identically ${entry.failures} times this turn and was NOT re-executed. ` +
    `Repeating it cannot change the result. Change the arguments or the approach ` +
    `(if you passed a name or title, pass the id instead; if you are missing an id, get it from the relevant list tool). ` +
    `Last error: ${entry.lastError.slice(0, 300)}]`
  );
}

/**
 * Post-result bookkeeping. On an error, bumps the signature's failure count
 * and returns a corrective notice to APPEND to the result when the count
 * reaches WARN_AT (once, at exactly WARN_AT, so the notice does not spam).
 * On success, clears the signature. Returns null when nothing should append.
 */
export function recordIdenticalCallResult(
  state: RepeatCallState,
  sig: string,
  isError: boolean,
  errorText: string,
): string | null {
  if (!isError) {
    state.delete(sig);
    return null;
  }
  const entry = state.get(sig) ?? { failures: 0, lastError: '' };
  entry.failures += 1;
  entry.lastError = errorText;
  state.set(sig, entry);
  if (entry.failures === IDENTICAL_CALL_WARN_AT) {
    return (
      `\n\n[Engine: this exact call has now failed ${entry.failures} times in a row with the same result. ` +
      `Repeating it will not change anything. Change the arguments (a name or title is not an id) or change the approach. ` +
      `After ${IDENTICAL_CALL_REFUSE_AT} identical failures the engine stops executing this call.]`
    );
  }
  return null;
}
