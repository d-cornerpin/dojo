// ════════════════════════════════════════════════════════════════════════════
// THE IN-PROCESS SECRET-VALUE SET (PHASE-4 T5b, split out at PHASE-5 T1)
// — and, since PHASE-5 T6B, the seam that hands the value back.
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
//
// ════════════════════════════════════════════════════════════════════════════
// PHASE-5 T6B — THE OTHER HALF OF THE OBLIGATION (RULING P5-R11)
// ════════════════════════════════════════════════════════════════════════════
// A credential the platform stores must not sit in the clear at rest AND the
// agent must still be able to USE it. Redaction alone was only the first half,
// and the second half had quietly stopped working: `assembleContext` rebuilds
// the model's array from the STORED rows on every tool-loop iteration, so from
// the second iteration onward the model was reading its own previous call with
// the placeholder in it — and copying the placeholder into the next command.
// Measured, twice, on the box (PHASE-5 T6 §2 and T6B §2).
//
// So this module now owns both directions of one seam:
//   REDACT at persist  — value  → placeholder      (what the platform stores)
//   HYDRATE at the provider boundary — placeholder → value   (what the agent reads)
//
// THREE PROPERTIES MAKE THAT SAFE RATHER THAN LUCKY, and each is a test clause
// in `__tests__/credential-hydration.test.ts`:
//
//   1. THE PLACEHOLDER SAYS WHICH VALUE IT REPLACED. One opaque sentinel cannot
//      be put back once an agent holds two secrets, and guessing between them is
//      worse than not restoring at all. The handle is an in-process COUNTER and
//      is deliberately NOT derived from the value: a truncated digest of a
//      secret sitting at rest is a (weak) oracle on that secret; a counter
//      carries no information about it at all. The counter is global, so a tag
//      minted for one agent can never collide with another agent's.
//   2. A DEAD VALUE IS NEVER PRESENTABLE AS A LIVE ONE (the owner's decision).
//      After a restart this map is empty, so nothing can be restored, and what
//      the agent reads instead SAYS SO and names the way out — call
//      `credential_get` again. The same holds for the untagged placeholder
//      every release before this one wrote: those rows are never edited (OR7 /
//      roadmap #10 — historical message bytes are never rewritten), they are
//      simply read out as what they are.
//   3. WITH NO CREDENTIAL IN FLIGHT THE SEAM DOES NOTHING, BY REFERENCE.
//      `hydrateCredentialsInMessages` returns the caller's own array when no
//      placeholder is present, so the assembled prompt cannot move because of
//      this seam. That is the cache-preservation tenet held structurally rather
//      than hoped for, and it is asserted, not observed once.
//
// SCOPE: a value is restored only for the agent that handled it, and only from
// what THIS process is holding. Nothing is ever read back out of the database.
// ════════════════════════════════════════════════════════════════════════════

/**
 * What replaces a secret in a stored, indexed or broadcast copy when the
 * replacement carries no handle — a DECLARED secret field's value (the store
 * direction: `credential_add`, `credential_update`,
 * `technique_set_placeholder`). These are deliberately NOT hydrated: the value
 * went INTO the encrypted store, so the way to use it again is to fetch it, and
 * putting it back into the replayed history would keep the owner's typed secret
 * in the model's window for the rest of the conversation.
 */
export const REDACTED_CREDENTIAL = '<redacted-credential>';

/** The tagged form: identifies WHICH handled value this placeholder replaced. */
const TAGGED_PREFIX = '<redacted-credential:';

/**
 * What the agent reads where a value used to be but this process no longer
 * holds it — after a restart, for another agent's value, or for a row written
 * before the tagged form existed. It is self-describing on purpose: the owner's
 * decision is that a dead value must never be presentable as a live one, so the
 * text names the tool that gets a live one.
 */
export const CREDENTIAL_STALE_PLACEHOLDER =
  '<credential not in context — call credential_get to fetch it again>';

/** Matches both forms, tagged and untagged. */
const PLACEHOLDER_RE = /<redacted-credential(?::([a-z0-9]+))?>/g;

// ── The in-process value set (moved here from credentials/tools.ts, T5b) ──
//
// Length-gated so a trivial value ("1", "on") that happens to sit in a
// credential field never turns into a scrub rule that rewrites unrelated text.
// The STRUCTURAL redaction above has no such gate: a one-character secret in a
// declared field is still replaced in the stored arguments.
const MIN_REDACTABLE_CREDENTIAL_LEN = 6;

/** Per agent: the values it has handled, each with its in-process handle. */
type AgentSecrets = {
  /** value → tag */
  byValue: Map<string, string>;
  /** tag → value */
  byTag: Map<string, string>;
};
const handedCredentialValues = new Map<string, AgentSecrets>();

/** Global so a tag minted for one agent can never be a valid tag for another. */
let tagCounter = 0;

/** Register secret values this agent has handled, in either direction. */
export function noteHandedCredentialValues(agentId: string, values: string[]): void {
  if (values.length === 0) return;
  let state = handedCredentialValues.get(agentId);
  if (!state) { state = { byValue: new Map(), byTag: new Map() }; handedCredentialValues.set(agentId, state); }
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_REDACTABLE_CREDENTIAL_LEN) continue;
    if (state.byValue.has(v)) continue;
    const tag = `c${++tagCounter}`;
    state.byValue.set(v, tag);
    state.byTag.set(tag, v);
  }
}

/** True if this agent has handled any redactable credential value this process. */
export function hasHandedCredentialValues(agentId: string): boolean {
  const state = handedCredentialValues.get(agentId);
  return !!state && state.byValue.size > 0;
}

/**
 * The placeholder that stands for one specific handled value. Exported so a
 * test can build the stored shape without ever writing a secret into a fixture
 * by hand; production reaches it through `redactHandedCredentials`.
 */
export function redactedPlaceholderFor(agentId: string, value: string): string {
  const tag = handedCredentialValues.get(agentId)?.byValue.get(value);
  return tag ? `${TAGGED_PREFIX}${tag}>` : REDACTED_CREDENTIAL;
}

/** Replace any credential value this agent has handled with its placeholder.
 *  Returns the input unchanged when nothing matches (the common case), so it is
 *  cheap to call on every persisted string. */
export function redactHandedCredentials(agentId: string, text: string): string {
  const state = handedCredentialValues.get(agentId);
  if (!state || state.byValue.size === 0 || !text) return text;
  let out = text;
  // Longest first: when one handled value contains another (a token and the
  // prefix it was minted from), replacing the short one first would leave the
  // long one half-rewritten and unrestorable.
  const values = [...state.byValue.keys()].sort((a, b) => b.length - a.length);
  for (const secret of values) {
    if (out.includes(secret)) out = out.split(secret).join(`${TAGGED_PREFIX}${state.byValue.get(secret)}>`);
  }
  return out;
}

/**
 * THE READ SIDE. Put back the values THIS process is holding for THIS agent,
 * and render every other placeholder as self-describing.
 *
 * Returns the input by reference when it carries no placeholder — the fast path
 * and the structural guarantee both, since a string that cannot change cannot
 * move a cached prefix.
 */
export function hydrateHandedCredentials(agentId: string, text: string): string {
  if (!text || !text.includes('<redacted-credential')) return text;
  const byTag = handedCredentialValues.get(agentId)?.byTag;
  return text.replace(PLACEHOLDER_RE, (_m, tag: string | undefined) => {
    if (!tag) return CREDENTIAL_STALE_PLACEHOLDER; // untagged: pre-T6B or a declared field
    const value = byTag?.get(tag);
    return value ?? CREDENTIAL_STALE_PLACEHOLDER;  // not held here: restarted, or another agent's
  });
}

/** Deep-walk any JSON-ish value, hydrating strings. Same reference if nothing changed. */
function hydrateDeep(agentId: string, value: unknown): unknown {
  if (typeof value === 'string') return hydrateHandedCredentials(agentId, value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => { const h = hydrateDeep(agentId, v); if (h !== v) changed = true; return h; });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const h = hydrateDeep(agentId, v);
      if (h !== v) changed = true;
      out[k] = h;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * THE ONE PRODUCTION SEAM: the array the model is handed, with this agent's own
 * credential values put back. Never mutates its input, and returns the SAME
 * ARRAY when no placeholder is present anywhere — which is every turn that has
 * not fetched a credential, i.e. almost all of them.
 *
 * Called at the provider boundary and nowhere else (held by a census clause in
 * `__tests__/credential-hydration.test.ts`), so assembly, the context receipt
 * and the dev instruments all see the placeholder and never the value.
 */
export function hydrateCredentialsInMessages<T extends { role: string; content: unknown }>(
  agentId: string,
  messages: readonly T[],
): T[] {
  let changed = false;
  const out = messages.map((m) => {
    const content = hydrateDeep(agentId, m.content);
    if (content === m.content) return m;
    changed = true;
    return { ...m, content } as T;
  });
  return changed ? out : (messages as T[]);
}

/** Test seam: forget everything known about one agent (or all of them). */
export function forgetHandedCredentialValues(agentId?: string): void {
  if (agentId === undefined) handedCredentialValues.clear();
  else handedCredentialValues.delete(agentId);
}
