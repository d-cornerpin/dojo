// ════════════════════════════════════════════════════════════════════════════
// DECLARED SECRET FIELDS — the one place the platform says which tool arguments
// carry credential material, and the one redactor that keeps those characters
// out of every copy it stores.
//
// PHASE-4 T5b (owner ruling P4-R2). `credential-never-persisted`'s first live
// run found a key the owner typed into chat sitting at rest in the `tool_use`
// ARGUMENTS of the agent's own `credential_add` call — a `role='assistant'` row
// that is replayed to the model provider on every later turn — and, downstream
// of that same row, in `agent_tool_failures.signature` and in the semantic
// index's `embeddings.content_preview`.
//
// ── WHY THIS IS KEYED ON DECLARED FIELDS AND NEVER ON VALUE SHAPES ──
// The obvious redactor matches what a secret LOOKS like: `sk-...`, 32+ hex
// chars, "password=". That is prose-keying, the disease this overhaul exists to
// remove — it fires on a wedding transcript that happens to quote a token, and
// it stays silent on the credential that does not match the pattern anyone
// thought of. So the key here is the SCHEMA: a tool declares, in its own
// `input_schema`, that a field carries credential material, and this module
// redacts exactly those fields. A field that is not declared is not redacted,
// which is a limitation with a name rather than a silent hole. (A value-pattern
// fallback, if it is ever wanted, is Phase 5's registry question.)
//
// ── REDACTION IS AT PERSIST, NOT AT EXECUTION ──
// Nothing here ever touches the arguments the tool actually runs with. The
// executor receives the real value and the credential really gets stored; only
// the copy that goes into a row, an index, a dedup key or a broadcast carries
// the sentinel. The agent's ability to USE the credential is untouched: it
// calls `credential_get` at API-call time, which is the platform's own stated
// contract ("the encrypted credentials store … is the only authoritative copy").
//
// ── THE SECOND MECHANISM, AND WHY IT IS THE SAME ONE ──
// Below the field map is the in-process set of secret VALUES this agent has
// handled. It predates T5b (NEXT-WAVE item 5: a value handed out by
// `credential_get` can be inlined into a shell command, the classic
// `sshpass -p '<pw>'`), and T5b feeds the same set from the other direction —
// values the agent handed IN through a declared secret field. One set, one
// redactor, both directions: a value is scrubbed from a persisted string
// because a DECLARED FIELD said it was a secret, never because of its shape.
// In-memory only, which is where a secret is allowed to live.
// ════════════════════════════════════════════════════════════════════════════

import { resolveToolAlias } from '../tools/aliases.js';

/** What replaces a secret in any stored, indexed or broadcast copy. */
export const REDACTED_CREDENTIAL = '<redacted-credential>';

/**
 * The enumeration, by tool name → the fields of THAT TOOL'S OWN input schema
 * that carry credential material. Derived by reading all 437 tool definitions
 * returned by `getAllToolDefinitions()` (PHASE-4 T5b; the command and the full
 * dump are in that task's report). Three fields on three tools is the whole of
 * it today:
 *
 *   credential_add.credentials         "The credential payload as an object.
 *   credential_update.credentials       Single-key APIs: {api_key: "..."}"
 *   technique_set_placeholder.value    "The actual value (API key, token, URL,
 *                                       etc.) the user provided"
 *
 * DELIBERATELY NOT HERE, each with its reason:
 *   * `credential_get.service_name` / `credential_delete.service_name` — a
 *     service NAME is not secret material, and redacting it would blind the
 *     cross-turn failure ledger to which service kept failing.
 *   * `approve_destructive_action.token` — an engine-minted, single-use
 *     approval nonce that the engine itself prints into the approval-request
 *     message it stores. Redacting one copy of a value the platform published
 *     in the row above it is theatre.
 *   * `vault_remember.content` — the vault REFUSES credential-shaped content
 *     (`vault/tools.ts:detectCredentialContent`); its field is declared as
 *     knowledge, not as a secret.
 *
 * A new tool with a secret-bearing field adds a line HERE. That is the whole
 * maintenance contract, and it is why this is a map rather than a matcher.
 */
export const SECRET_TOOL_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['credential_add', ['credentials']],
  ['credential_update', ['credentials']],
  ['technique_set_placeholder', ['value']],
]);

/**
 * The declared secret fields of a tool, by CANONICAL name. Aliases resolve
 * first: no alias points into the credential family today, and this keeps that
 * true by construction rather than by a comment.
 */
export function secretFieldsFor(toolName: string): readonly string[] | undefined {
  const direct = SECRET_TOOL_FIELDS.get(toolName);
  if (direct) return direct;
  const resolved = resolveToolAlias(toolName, {});
  return resolved.tombstone ? undefined : SECRET_TOOL_FIELDS.get(resolved.name);
}

/** Every leaf of a declared secret field becomes the sentinel; structure stays. */
function redactLeaves(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactLeaves(v);
    return out;
  }
  // Strings, numbers and booleans alike: a 6-digit PIN is as much a secret as a
  // token, and the field said so. Keys survive, values do not — the replayed
  // history still shows the model WHICH fields it sent.
  return REDACTED_CREDENTIAL;
}

/** Every string leaf of a declared secret field, for the value-scrub set. */
function collectLeafStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') { into.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectLeafStrings(v, into); return; }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectLeafStrings(v, into);
  }
}

/**
 * The persisted form of a tool call's arguments. Returns the SAME REFERENCE
 * when the tool declares no secret field (the overwhelmingly common case, and
 * the reason this is cheap enough to call on every persisted tool call), and
 * never mutates the input — the live call keeps the real values.
 */
export function redactDeclaredSecretArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args) return args;
  const fields = secretFieldsFor(toolName);
  if (!fields) return args;
  let out: Record<string, unknown> | null = null;
  for (const field of fields) {
    if (!(field in args)) continue;
    if (!out) out = { ...args };
    out[field] = redactLeaves(args[field]);
  }
  return out ?? args;
}

/**
 * Learn this result's secrets before it reaches ANY persist, index or broadcast
 * seam: the values a declared secret field carried are registered for the
 * value-scrub below, so the same row's reasoning text and this process's later
 * stored copies lose them too. Called once per model result; idempotent.
 */
export function noteDeclaredSecretsFromToolCalls(
  agentId: string,
  toolCalls: ReadonlyArray<{ name: string; arguments?: Record<string, unknown> }>,
): void {
  const found: string[] = [];
  for (const tc of toolCalls) {
    const fields = secretFieldsFor(tc.name);
    if (!fields || !tc.arguments) continue;
    for (const field of fields) collectLeafStrings(tc.arguments[field], found);
  }
  if (found.length > 0) noteHandedCredentialValues(agentId, found);
}

/**
 * THE PERSIST SEAM for an assistant turn's own output blocks.
 *
 * One function so the two redactions cannot drift apart or be applied in the
 * wrong order:
 *   1. STRUCTURAL — a declared secret field's value never enters a stored
 *      `tool_use` argument, whatever it contains.
 *   2. VALUE — any secret this agent has handled is scrubbed from the rest of
 *      the row (the text it wrote alongside the call, another tool's arguments
 *      that inlined the value — the `sshpass -p '<pw>'` case).
 *
 * The caller keeps its own untouched array for the live model call; this
 * returns the copy that goes into `messages` and onto the socket.
 */
export function redactAssistantBlocksForPersist<T extends { type: string }>(
  agentId: string,
  blocks: readonly T[],
): T[] {
  const scrubValues = hasHandedCredentialValues(agentId);
  const scrubValue = (v: unknown): unknown => {
    if (typeof v === 'string') return redactHandedCredentials(agentId, v);
    if (Array.isArray(v)) return v.map(scrubValue);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = scrubValue(val);
      return o;
    }
    return v;
  };
  return blocks.map((block) => {
    if (block.type === 'tool_use') {
      const b = block as unknown as { name: string; input?: Record<string, unknown> };
      const declared = redactDeclaredSecretArgs(b.name, b.input);
      const input = scrubValues ? scrubValue(declared) : declared;
      return (input === b.input ? block : { ...block, input }) as T;
    }
    if (block.type === 'text' && scrubValues) {
      const b = block as unknown as { text: string };
      return { ...block, text: redactHandedCredentials(agentId, b.text) } as T;
    }
    return block;
  });
}

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
