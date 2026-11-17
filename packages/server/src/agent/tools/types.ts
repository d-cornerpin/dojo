// THE TOOL-DEFINITION LEAF: types only, ZERO runtime imports, so anything may depend on it.
// Nothing may be added INSIDE input_schema: it ships to the provider and the cache golden hashes it.

import type { ToolScale } from '../../tools/scale-facts.js';
export type EffectKind =
  | 'fs_read'
  | 'fs_write'
  | 'fs_delete'
  | 'proc'
  | 'shell'
  | 'applescript'
  | 'net'
  | 'send'
  | 'spawn'
  | 'secrets';

/** What a tool does, in the brokers' vocabulary. `net` is this platform's own outbound door: a
 * URL handed to a provider to fetch is not one; `send` only when the CALLER names the recipient. */
export const EFFECT_KINDS: readonly EffectKind[] = [
  'fs_read', 'fs_write', 'fs_delete', 'proc', 'shell', 'applescript', 'net', 'send', 'spawn', 'secrets',
] as const;

/** ONE effect and its resource source: `args.<path>` (a real schema property), `fixed:`, `derived:`. */
export interface ToolEffect {
  kind: EffectKind;
  from: string;
  /** Machine-checkable half of a `derived:` declaration; no scope means the facade refuses. */
  scope?: EffectScope;
  /** Named indirection resolving an id to its recorded path; never a callback; no resolve, no grant. */
  via?: EffectIndirection;
  /** On a file read: the call hands the file's bytes off the Mac (mail, text, upload, another agent), so it is asked as a share. */
  leaves?: true;
}

export type EffectIndirection = 'attachment_row' | 'technique_dir' | 'agent_canvas_file' | 'office_local_path';

// Templates expand only `~`, `<agentId>` and `{args.<dotted>}` (one path segment, no globs). argTree: the
// root is the directory argument already authorized; agentResolved: the agent resolves its own recorded file.
export type EffectScope =
  | { readonly at: 'tree'; readonly template: string }
  | { readonly at: 'path'; readonly template: string }
  | { readonly at: 'program'; readonly program: string }
  | { readonly at: 'argTree' }
  | { readonly at: 'agentResolved'; readonly via: EffectIndirection };

export const EFFECT_FROM_ARGS = 'args.';
export const EFFECT_FROM_FIXED = 'fixed:';
export const EFFECT_FROM_DERIVED = 'derived:';

export interface ToolFieldDeclaration {
  /** This argument carries credential material; never store, index or broadcast its value. */
  secret?: true;
  /** Required, but "" or [] is a legitimate value (file_write content ""); read by validate-args.ts. */
  allowEmpty?: true;
  /** Guidance only; enforcing it at the validation boundary would be a NEW refusal, i.e. less capability. */
  requiredNotEnforced?: string;
}


export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  effects: readonly ToolEffect[];
  nonEffects?: Readonly<Record<string, string>>;
  /** Named token that is not a parameter -> reason; stale once the token is gone or declared (census). */
  advertisedNotDeclared?: Readonly<Record<string, string>>;
  fields?: Readonly<Record<string, ToolFieldDeclaration>>;
  /** The run class: safe runs in parallel, serial ordered, agent/special one at a time. Absent = special. */
  concurrency?: 'safe' | 'serial' | 'agent' | 'special';
  /** Must equal SEND_TO_PEOPLE (sensei-policy.ts keeps a leaf twin, test-enforced); not the 'send' effect. */
  reachesPeople?: true;
  /** Changes an account's data, so an agent needs the full level on that account (`access/workspace.ts`). */
  writes?: true;
  maxResultTokens?: number;
  scale?: ToolScale;   // what ONE call can do (several ids, a page); a sibling of input_schema, never on the wire
}
