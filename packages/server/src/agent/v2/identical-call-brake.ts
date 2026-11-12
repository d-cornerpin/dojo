// Mid-turn brake on one exact call signature (tool + canonical args) failing over and over: a warning notice
// at WARN_AT identical failures, then the engine refuses to execute it at REFUSE_AT. A success resets the
// signature, so poll-retry loops that eventually succeed and calls with distinct arguments are untouched.

export const IDENTICAL_CALL_WARN_AT = 3;
export const IDENTICAL_CALL_REFUSE_AT = 6;
// Refusals of one unchanged signature before the turn's tool phase ends. Counting refusals, not calls, keeps
// fan-outs and corrected retries safe: only a call that is not executing anyway can reach this rung.
export const IDENTICAL_CALL_TERMINAL_AT = 3;

export interface RepeatEntry {
  failures: number;
  refusals: number;
  lastError: string;
}

export type RepeatCallState = Map<string, RepeatEntry>;

// Stable JSON with keys sorted at every depth; a JSON.stringify replacer array would erase nested keys.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical signature: tool name + stable-stringified args. */
export function identicalCallSignature(tool: string, args: unknown): string {
  let argsKey: string;
  try {
    argsKey = stableStringify(args ?? {});
  } catch {
    argsKey = String(args);
  }
  return `${tool}:${argsKey}`;
}

/** Refusal text once this call has failed REFUSE_AT times (the caller returns it unexecuted), else null. */
export function checkIdenticalCallRefusal(state: RepeatCallState, sig: string): string | null {
  const entry = state.get(sig);
  if (!entry || entry.failures < IDENTICAL_CALL_REFUSE_AT) return null;
  entry.refusals += 1;
  return (
    `[Engine: this exact tool call has failed identically ${entry.failures} times this turn and was NOT re-executed. ` +
    `Repeating it cannot change the result. Change the arguments or the approach ` +
    `(if you passed a name or title, pass the id instead; if you are missing an id, get it from the relevant list tool). ` +
    `Last error: ${entry.lastError.slice(0, 300)}]`
  );
}

/** Counts a failure and returns a notice to append exactly once, at WARN_AT; a success clears the signature. */
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
  const entry = state.get(sig) ?? { failures: 0, refusals: 0, lastError: '' };
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

/** True once a signature has been refused TERMINAL_AT times; the loop then ends the turn's tool phase. */
export function isSignatureTerminal(state: RepeatCallState, sig: string): boolean {
  const entry = state.get(sig);
  return !!entry && entry.refusals >= IDENTICAL_CALL_TERMINAL_AT;
}

/** True when the engine refused any repeated call this turn (an engine decision, for the turn record). Read from
 *  this map, not latched at the refusal site, because parallel runOne callbacks clobber each other's state. */
export function anyIdenticalCallRefused(state: RepeatCallState): boolean {
  for (const entry of state.values()) if (entry.refusals > 0) return true;
  return false;
}
