// ════════════════════════════════════════════════════════════════════════════
// THE TOOL-DEFINITION LEAF (PHASE-5 T1)
//
// Every module that declares tool definitions used to reach for the type by
// importing `agent/tools.ts` — a 10,481-line module that imports eleven of them
// straight back. Fifteen modules did it; eleven of those were real cycles
// (§T0-PINS P8), and the cycles are why six call sites had to fetch a shared
// helper through `await import('../agent/tools.js')` at runtime.
//
// This module is the leaf that ends that: types only, ZERO imports, so anything
// may depend on it and nothing depends back. `agent/tools.ts` re-exports
// `ToolDefinition` from here so no consumer outside the tree has to move.
//
// ── WHY `effects` LIVES HERE AND NOT IN `input_schema` ──
// A declaration inside `input_schema` would be shipped to the model provider:
// `model.ts:2297-2301` projects `{name, description, input_schema}` onto the
// wire and passes `input_schema` through whole. The cache-prefix golden hashes
// exactly that projection, so one extra key inside a property would move the
// cached prefix and re-bill the whole tools array (OR7 / roadmap #10). Effects,
// field declarations and rulings are therefore SIBLINGS of `input_schema`, never
// children of it, and `effects-conformance.ts` holds a clause that keeps them
// out of the schema by test rather than by memory.
// ════════════════════════════════════════════════════════════════════════════

/**
 * WHAT A TOOL DOES TO THE WORLD, in the vocabulary the Phase-5 brokers
 * authorize. The eight kinds the plan declared (research 22 §2.1), plus two
 * derived at T1 because the ~15 argument-less effects had nowhere honest to go:
 *
 *   fs_read      reads a filesystem path
 *   fs_write     creates or modifies a filesystem path
 *   fs_delete    removes a filesystem path
 *   proc         executes a program
 *   shell        hands a caller-supplied string to a shell interpreter
 *   applescript  hands caller-supplied script text to osascript
 *   net          makes an outbound request to a target the CALLER chooses, or to
 *                a fixed third-party endpoint that is not a connected-account
 *                provider API
 *   send         delivers a message to a recipient the CALLER names
 *   spawn        creates a sub-agent, i.e. a new effect surface (T1 ADDITION —
 *                `spawn_agent` is named in §T0-PINS P3 as effectful and the
 *                ladder gates it at branch 4 with `checkPermission type:'spawn'`;
 *                calling that `proc` would have been false, and `[]` would have
 *                hidden a capability the registry exists to name)
 *   secrets      reads or writes the encrypted credential store (T1 ADDITION —
 *                the `credential_*` family is named in §T0-PINS P3 as effectful
 *                with no resource argument; measured at `d0b3320` the store is
 *                the `agent_credentials` table, so none of fs/proc/net/send is
 *                true of it)
 *
 * Both additions are recorded in PHASE-5.md's T1 AS-BUILT. They widen what can
 * be DECLARED; they gate nothing here (T2 owns enforcement).
 *
 * ── THE RULE THAT KEEPS THIS SET FROM SWALLOWING THE TOOLBOX ──
 * `net` is the PLATFORM's own outbound door. A URL handed to the Google Slides
 * or Microsoft Graph API for THAT provider to fetch is not this platform making
 * a request, and a read call against a connected account is the account grant's
 * business, not the network broker's. Those fields carry a `nonEffects` ruling
 * naming the reason instead of a `net` effect. Likewise `send` is declared when
 * the CALLER names the recipient — `complete_task` delivers to whoever spawned
 * the agent, which the caller does not choose, so it declares nothing.
 */
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

/** Every kind, for the conformance walk and any future coverage report. */
export const EFFECT_KINDS: readonly EffectKind[] = [
  'fs_read', 'fs_write', 'fs_delete', 'proc', 'shell', 'applescript', 'net', 'send', 'spawn', 'secrets',
] as const;

/**
 * ONE effect a tool has, and where its resource comes from.
 *
 * `from` has exactly three shapes, and the conformance walk enforces it:
 *   `args.<path>`      the resource is this argument. Dotted for nested objects,
 *                      `[]` for array elements: `dependencies.repos[].url`.
 *                      The path MUST resolve to a real property of this tool's
 *                      own `input_schema` — a renamed field fails the build
 *                      instead of silently un-declaring an effect.
 *   `fixed:<what>`     a constant this tool always touches (`web_search` only
 *                      ever reaches `api.search.brave.com`).
 *   `derived:<what>`   resolved at runtime from a non-resource argument or from
 *                      the agent's own identity (`technique_set_placeholder`
 *                      writes into the technique directory named by
 *                      `args.technique`; `image_create` writes into the calling
 *                      agent's uploads directory).
 *
 * The distinction is not cosmetic: T2's dispatcher can resolve and authorize an
 * `args.` effect before the handler runs, and cannot do that for the other two.
 */
export interface ToolEffect {
  kind: EffectKind;
  from: string;
  /**
   * THE MACHINE-CHECKABLE HALF OF A `derived:` DECLARATION (PHASE-5 T8,
   * RULING P5-R14 branch A).
   *
   * `from: 'derived:<prose>'` says a human read it and knew what it meant. It
   * cannot be enforced, because a sentence is not a scope. This sibling is the
   * same fact written so the executor can resolve it before dispatch — and it is
   * a SIBLING rather than a replacement so the prose survives: "we looked at
   * this and it is deliberate" and "nobody looked" must never read the same,
   * which is the same reason `nonEffects` carries reasons instead of flags.
   *
   * A `derived:` effect with no `scope` yields no resource grant at all, so the
   * facade refuses it rather than guessing — loudly, because a refusal on driven
   * traffic is the signal that a declaration is owed.
   */
  scope?: EffectScope;
  /**
   * THE ARGUMENT NAMES THE RESOURCE INDIRECTLY (PHASE-5 T8, RULING P5-R15
   * ADDENDUM mechanic 5).
   *
   * Some arguments are not a path but an IDENTIFIER the platform recorded a
   * path against — `transcribe_audio`'s `attachment_id` is the whole class.
   * There is no tree to declare for those (the recorded paths sit under several
   * distinct roots), and prose is not a scope, so the declaration names the
   * INDIRECTION instead: the gate loop resolves the identifier with the SAME
   * function the handler resolves it with and mints the grant for the one path
   * that row records.
   *
   * It is a NAMED indirection out of a fixed table, never a callback or a
   * predicate: a declaration cannot invent a way to turn an argument into a
   * resource, it can only point at one the platform already owns. An identifier
   * that resolves to nothing yields NO grant, so the handler keeps its own error
   * shape — a stale id must never become a bare refusal.
   */
  via?: EffectIndirection;
}

/**
 * The named indirections a declaration may point at. `attachment_row` resolves
 * an id to ONE recorded file; `technique_dir` resolves a technique reference (an
 * id, a slug OR a display name) to the directory its row records, which no scope
 * template can name — RULING P5-R15 ADDENDUM 3(1)(a); pair it with
 * `scope: { at: 'argTree' }` when the tool works INSIDE that directory. A LIST
 * rather than a shape, for the reason `CARRIED_PROGRAMS` is a list: a new way to
 * turn an argument into a resource has to be written here by hand to exist at
 * all, so the set cannot grow by declaration.
 */
export type EffectIndirection = 'attachment_row' | 'technique_dir' | 'agent_canvas_file' | 'office_local_path';

/**
 * WHERE A DERIVED EFFECT ACTS, declared so it can be checked.
 *
 * Templates expand exactly three things and nothing else — no globs, no regexes,
 * no code: `~` (home), `<agentId>` (the calling agent) and `{args.<dotted>}`
 * (one argument of this call, one path segment, never a separator).
 *
 *   `tree`     a directory the tool works inside (an uploads dir, a technique dir)
 *   `path`     one file the tool always touches
 *   `program`  a fixed program the tool spawns whose argv it builds itself —
 *              RULING P5-R14 branch (B), carried and audited from an explicit
 *              named list rather than matched.
 */
export type EffectScope =
  | { readonly at: 'tree'; readonly template: string }
  | { readonly at: 'path'; readonly template: string }
  | { readonly at: 'program'; readonly program: string }
  /**
   * THE ARGUMENT NAMES A DIRECTORY AND THE EFFECT COVERS WHAT IS INSIDE IT
   * (PHASE-5 T8, RULING P5-R15 part 1 — the `file_list` tree-scope resolver).
   *
   * `file_list` is the whole class: it is given a directory and it stats every
   * entry IN that directory. A grant on the directory alone is not what the
   * tool does, and converting the call site without this would have made every
   * entry's size column silently read `-`, because the handler's own `catch`
   * turns a refusal into a dash. **A silent narrowing is the failure mode this
   * task exists to prevent**, and a call-site workaround would have hidden it.
   *
   * It qualifies an `args.` effect — the root is the argument the brokers just
   * resolved and authorized, so it needs no template of its own, and it can
   * never be wider than the directory the agent named and the gate allowed.
   */
  | { readonly at: 'argTree' }
  /**
   * THE CALL'S OWN AGENT IDENTITY RESOLVES A PER-AGENT RECORDED RESOURCE
   * (PHASE-5 T8, RULING P5-R15 ADDENDUM 3(1)(b)). `canvas_read` is the whole
   * class: its schema names no path and its call site passes none, because the
   * file it reads is the one this agent put on its own canvas EARLIER. There is
   * no argument to resolve, so the identity of the call is the key and the named
   * resolver is the handler's own reader; an agent with nothing recorded
   * resolves to nothing and gets no grant.
   */
  | { readonly at: 'agentResolved'; readonly via: EffectIndirection };

/** Prefixes `from` may carry. Exported so the walk and the brokers share one list. */
export const EFFECT_FROM_ARGS = 'args.';
export const EFFECT_FROM_FIXED = 'fixed:';
export const EFFECT_FROM_DERIVED = 'derived:';

/**
 * Per-FIELD declarations that are true of the argument but are not part of the
 * JSON schema the provider receives.
 *
 * `secret: true` is the whole of it today, and it is the durable fix for
 * PHASE-4 exit §8 item 2: `credentials/secret-fields.ts` used to hold a
 * hand-maintained map of tool → secret-bearing fields, and NOTHING failed when
 * a new tool's line was missing. The declaration now lives on the definition
 * and that map reads it.
 */
export interface ToolFieldDeclaration {
  /** This argument carries credential material; never store, index or broadcast its value. */
  secret?: true;
  /**
   * This field is REQUIRED, but an empty string / empty array is a legitimate
   * value for it. No JSON-schema keyword says that, and the difference is a
   * real capability: `file_write({path, content: ""})` writes an empty file and
   * always has, so a validator compiled from `input_schema` alone would refuse
   * a working call ("`content` cannot be empty."). Consumed by the one
   * validation boundary in `agent/tools/validate-args.ts`.
   */
  allowEmpty?: true;
  /**
   * WHY this `input_schema.required` field is NOT enforced at the validation
   * boundary. `required` is also model-facing guidance, and for a handful of
   * fields it is stricter than anything the runtime has ever refused — the
   * handler validates them with a richer, tool-specific message, or accepts an
   * argument ALIAS the schema cannot express, or supplies a default. Compiling
   * those into the boundary would be a NEW REFUSAL, i.e. less capability, which
   * RULING P5-R8 forbids this conversion from inventing.
   *
   * The value is the reason, never a bare flag, for the same purpose
   * `nonEffects` serves: "we looked at this and it is deliberate" and "nobody
   * looked" must never read the same.
   */
  requiredNotEnforced?: string;
}

// ── Tool Schemas for Anthropic API ──

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /**
   * WHAT THIS TOOL DOES TO THE WORLD. Required on every definition — an empty
   * array is a statement ("this tool touches nothing a broker owns"), and the
   * conformance walk refuses a definition that says nothing at all. The
   * enumeration is the SOURCE OF TRUTH; the field scan in
   * `effect-conformance.ts` is only a tripwire against a declaration going
   * missing, because a scan of any depth cannot see `web_search`'s fixed host,
   * `spawn_agent`'s child, or the eight Plaud tools' `npx` subprocess.
   */
  effects: readonly ToolEffect[];
  /**
   * FIELDS THAT LOOK EFFECTFUL AND ARE NOT, each with the reason. The tripwire
   * fires on any path/url/command-shaped field that the definition neither
   * declares an effect for nor rules on here, so "we thought about it and it is
   * inert" and "nobody looked" can never read the same.
   *
   * Keys are the same dotted paths `ToolEffect.from` uses, without the `args.`
   * prefix. Two classes live here today: locators that are STORED and never
   * dereferenced (`work_update.evidence[].pointer`, `vault_remember.source_ref`)
   * and URLs handed to a PROVIDER to fetch (`slides_add_image.image_url`).
   */
  nonEffects?: Readonly<Record<string, string>>;
  /** Per-field declarations that never reach the wire. See `ToolFieldDeclaration`. */
  fields?: Readonly<Record<string, ToolFieldDeclaration>>;
  /**
   * Concurrency category. Phase 3 (2026-05-04) made this the canonical
   * source for the v2 partitioner, `partitionTools` checks this first,
   * then falls back to `TOOL_CATEGORY` in concurrency.ts. Annotate new
   * tools here; the fallback map covers existing tools that haven't
   * been migrated yet.
   *
   *   safe, pure read, no side effects, parallelizable
   *   serial, has side effects, must run in order
   *   agent, coordinates with other agents, sequential
   *   special, one-of-a-kind semantics, sequential
   */
  concurrency?: 'safe' | 'serial' | 'agent' | 'special';
  /**
   * Declared comms-to-people tier (lanes & lineage P7b). True = this tool is a
   * member of the comms-to-people surface: it reaches a real person on an owner
   * channel (email / Teams / SMS / iMessage / voice), including the auxiliary
   * channel tools on those surfaces (contact list, call lifecycle/status). The
   * runtime deny set stays the leaf list in sensei-policy.ts (module has no
   * imports by design, so it cannot derive from this registry), but the
   * DECISION is declared here at the definition site: the tool-list conformance
   * test and the release gate enforce two-way equality between every
   * `reachesPeople: true` declaration and SEND_TO_PEOPLE, so drift in either
   * direction fails the build naming the tool. user_ twins inherit the flag via
   * the twin-generation spread and are covered by the twin-parity check.
   *
   * NOTE (T1): `reachesPeople` and `effects: [{kind:'send'}]` are deliberately
   * NOT the same set and neither is derived from the other. `reachesPeople` is
   * membership of the owner-channel comms surface (it includes read-side
   * auxiliaries like `imessage_list_contacts` and `voice_call_status`); a `send`
   * effect is "this call delivers a message to a recipient the caller names".
   * The overlap is large and the two disagree on purpose at both ends.
   */
  reachesPeople?: true;
  /**
   * Per-tool result cap in tokens. When the tool's content output exceeds
   * this, the tool itself truncates and appends a "[First N tokens of …]"
   * trailer with re-call guidance. Phase 3 added this so context stays
   * small structurally, `file_read` of a 50K file spends 8K tokens
   * instead of 50K. Roughly 1 token ≈ 4 characters; tools may apply
   * approximate enforcement on character count.
   */
  maxResultTokens?: number;
}
