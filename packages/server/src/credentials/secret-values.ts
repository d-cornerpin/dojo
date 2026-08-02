// ════════════════════════════════════════════════════════════════════════════
// THE IN-PROCESS SECRET-VALUE SET (PHASE-4 T5b, split out at PHASE-5 T1)
//
// Values this process has handled that must never appear in a stored, indexed
// or broadcast string. A value is only ever learned from a DECLARED secret
// field, never from its shape — the prose-keying this overhaul exists to
// delete. In-memory only, which is where a secret is allowed to live.
//
// WHY IT IS ITS OWN MODULE NOW, and it is a graph fact rather than a taste:
// `secret-fields.ts` became a READER of the tool definitions at T1, so it
// imports the registry, which imports `agent/tools.ts`, which imports
// `credentials/tools.ts` — and `credentials/tools.ts` needs
// `noteHandedCredentialValues` at the moment `credential_get` hands a value
// out. Left in one module that is a cycle. This leaf imports NOTHING, so
// `credentials/tools.ts` reaches the value set directly and the loop does not
// exist. T5b's "one owner for which-fields and which-values" survives intact:
// `secret-fields.ts` re-exports every function below, so it is still the single
// import surface for every consumer that had one, and the redaction seam that
// applies both directions is still one function in one file.
// ════════════════════════════════════════════════════════════════════════════

/** What replaces a secret in any stored, indexed or broadcast copy. */
export const REDACTED_CREDENTIAL = '<redacted-credential>';

// ── The in-process value set (moved here from credentials/tools.ts, T5b) ──
//
// Length-gated so a trivial value ("1", "on") that happens to sit in a
// credential field never turns into a scrub rule that rewrites unrelated text.
// The STRUCTURAL redaction above has no such gate: a one-character secret in a
// declared field is still replaced in the stored arguments.
const MIN_REDACTABLE_CREDENTIAL_LEN = 6;
const handedCredentialValues = new Map<string, Set<string>>();

/** Register secret values this agent has handled, in either direction. */
export function noteHandedCredentialValues(agentId: string, values: string[]): void {
  if (values.length === 0) return;
  let set = handedCredentialValues.get(agentId);
  if (!set) { set = new Set<string>(); handedCredentialValues.set(agentId, set); }
  for (const v of values) {
    if (typeof v === 'string' && v.length >= MIN_REDACTABLE_CREDENTIAL_LEN) set.add(v);
  }
}

/** True if this agent has handled any redactable credential value this process. */
export function hasHandedCredentialValues(agentId: string): boolean {
  const set = handedCredentialValues.get(agentId);
  return !!set && set.size > 0;
}

/** Replace any credential value this agent has handled with the sentinel.
 *  Returns the input unchanged when nothing matches (the common case), so it is
 *  cheap to call on every persisted string. */
export function redactHandedCredentials(agentId: string, text: string): string {
  const set = handedCredentialValues.get(agentId);
  if (!set || set.size === 0 || !text) return text;
  let out = text;
  for (const secret of set) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED_CREDENTIAL);
  }
  return out;
}

/** Test seam: forget everything known about one agent (or all of them). */
export function forgetHandedCredentialValues(agentId?: string): void {
  if (agentId === undefined) handedCredentialValues.clear();
  else handedCredentialValues.delete(agentId);
}
