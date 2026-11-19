// Redacts the tool arguments a definition declares secret (`fields: { <arg>: { secret: true } }`), never by
// value shape; an undeclared field is not redacted. The declaration sits beside input_schema, not in it,
// because input_schema goes to the provider verbatim. Only stored copies change; the executor gets real values.

import { resolveToolAlias } from '../tools/aliases.js';
import { declaredSecretFieldsByTool } from '../agent/tools/registry.js';
// secret-values.ts is a leaf so credentials/tools.ts reaches it without a cycle through the tool registry.
import {
  REDACTED_CREDENTIAL,
  noteHandedCredentialValues,
  hasHandedCredentialValues,
  redactHandedCredentials,
} from './secret-values.js';
export {
  REDACTED_CREDENTIAL,
  noteHandedCredentialValues,
  hasHandedCredentialValues,
  redactHandedCredentials,
  forgetHandedCredentialValues,
} from './secret-values.js';


// Declared secret fields by tool, memoised because every persisted tool call reads it. Deliberately undeclared:
// credential_get/delete service_name (not secret), approve_destructive_action.token (the engine prints it
// itself), vault_remember.content (the vault refuses credential-shaped content).
let secretFieldMemo: ReadonlyMap<string, readonly string[]> | null = null;

function secretToolFields(): ReadonlyMap<string, readonly string[]> {
  if (!secretFieldMemo) secretFieldMemo = declaredSecretFieldsByTool();
  return secretFieldMemo;
}

export function getSecretToolFields(): ReadonlyMap<string, readonly string[]> {
  return secretToolFields();
}

/** Declared secret fields by canonical name; aliases resolve first. */
export function secretFieldsFor(toolName: string): readonly string[] | undefined {
  const fields = secretToolFields();
  const direct = fields.get(toolName);
  if (direct) return direct;
  const resolved = resolveToolAlias(toolName, {});
  return resolved.tombstone ? undefined : fields.get(resolved.name);
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
  // Every leaf type, since a PIN is a secret too; keys survive so replayed history shows which fields were sent.
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

/** Persisted args: the same reference when nothing is declared, and the input is never mutated. */
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
  // Unparsed arguments keep their raw text under this key; for a tool that declares a secret it may hold one.
  if (typeof args.__malformed_args === 'string') out = { ...(out ?? args), __malformed_args: REDACTED_CREDENTIAL };
  return out ?? args;
}

/** Register declared secret values for the value scrub before any persist, index or broadcast; idempotent. */
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

// The persist seam for assistant blocks: declared-field redaction first, then the handled-value scrub.
// Returns the stored copy; the caller keeps its own untouched array for the live model call.
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
