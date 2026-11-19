// In-memory set of credential values each agent handled (declared secret fields, credential_get results).
// Redact at persist (value to tagged placeholder); hydrate at the provider boundary (placeholder to value).
// Tags are random, never derived from a value or reused after a restart; a value this process no longer holds reads as stale.
// No chat reveal seam exists: the agent never shows a credential; a person sees it in the vault tab only.
// This leaf imports only node:crypto, so credentials/tools.ts can reach it without a cycle; secret-fields.ts re-exports it.

import crypto from 'node:crypto';

/** Untagged placeholder for declared-field values; never hydrated, the value lives in the encrypted store. */
export const REDACTED_CREDENTIAL = '<redacted-credential>';

const TAGGED_PREFIX = '<redacted-credential:';

/** What the agent reads for a value this process no longer holds; it names the way to get a live one. */
export const CREDENTIAL_STALE_PLACEHOLDER =
  '<credential not in context — call credential_get to fetch it again>';

const PLACEHOLDER_RE = /<redacted-credential(?::([a-z0-9]+))?>/g;

// Short values ("1", "on") never become scrub rules; structural redaction of declared fields has no such gate.
const MIN_REDACTABLE_CREDENTIAL_LEN = 6;

type AgentSecrets = {
  byValue: Map<string, string>;
  byTag: Map<string, string>;
};
const handedCredentialValues = new Map<string, AgentSecrets>();

export function noteHandedCredentialValues(agentId: string, values: string[]): void {
  if (values.length === 0) return;
  let state = handedCredentialValues.get(agentId);
  if (!state) { state = { byValue: new Map(), byTag: new Map() }; handedCredentialValues.set(agentId, state); }
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_REDACTABLE_CREDENTIAL_LEN) continue;
    if (state.byValue.has(v)) continue;
    let tag: string;
    do { tag = crypto.randomBytes(4).toString('hex'); } while (state.byTag.has(tag));
    state.byValue.set(v, tag);
    state.byTag.set(tag, v);
  }
}

export function hasHandedCredentialValues(agentId: string): boolean {
  const state = handedCredentialValues.get(agentId);
  return !!state && state.byValue.size > 0;
}

export function redactedPlaceholderFor(agentId: string, value: string): string {
  const tag = handedCredentialValues.get(agentId)?.byValue.get(value);
  return tag ? `${TAGGED_PREFIX}${tag}>` : REDACTED_CREDENTIAL;
}

/** The only redactor: handled values become tagged placeholders; unmatched input is returned as is. */
export function redactHandedCredentials(agentId: string, text: string): string {
  const state = handedCredentialValues.get(agentId);
  if (!state || state.byValue.size === 0 || !text) return text;
  let out = text;
  // Longest first, so a value that contains another is never half-rewritten and unrestorable.
  const values = [...state.byValue.keys()].sort((a, b) => b.length - a.length);
  for (const secret of values) {
    if (out.includes(secret)) out = out.split(secret).join(`${TAGGED_PREFIX}${state.byValue.get(secret)}>`);
  }
  return out;
}

/** Restore this agent's held values; other placeholders read as stale. Same string when none is present. */
export function hydrateHandedCredentials(agentId: string, text: string): string {
  if (!text || !text.includes('<redacted-credential')) return text;
  const byTag = handedCredentialValues.get(agentId)?.byTag;
  return text.replace(PLACEHOLDER_RE, (_m, tag: string | undefined) => {
    if (!tag) return CREDENTIAL_STALE_PLACEHOLDER; // untagged: an older row or a declared field
    const value = byTag?.get(tag);
    return value ?? CREDENTIAL_STALE_PLACEHOLDER;  // not held here: restarted, or another agent's
  });
}

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

// Called only at the provider boundary, so assembly and receipts never see a value. Hydrates content and
// reasoningContent (sent back on tool-call turns); returns the same array when no placeholder exists.
export function hydrateCredentialsInMessages<
  T extends { role: string; content: unknown; reasoningContent?: string },
>(
  agentId: string,
  messages: readonly T[],
): T[] {
  let changed = false;
  const out = messages.map((m) => {
    const content = hydrateDeep(agentId, m.content);
    const reasoning = typeof m.reasoningContent === 'string'
      ? hydrateHandedCredentials(agentId, m.reasoningContent)
      : m.reasoningContent;
    if (content === m.content && reasoning === m.reasoningContent) return m;
    changed = true;
    // Never add an undefined reasoningContent key, or a JSON copy stops matching what assembly produced.
    return (reasoning === m.reasoningContent
      ? { ...m, content }
      : { ...m, content, reasoningContent: reasoning }) as T;
  });
  return changed ? out : (messages as T[]);
}

/** Test seam: forget everything known about one agent (or all of them). */
export function forgetHandedCredentialValues(agentId?: string): void {
  if (agentId === undefined) handedCredentialValues.clear();
  else handedCredentialValues.delete(agentId);
}
