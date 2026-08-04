// ════════════════════════════════════════════════════════════════════════════
// FROM DECLARATION TO RESOLVED RESOURCE (PHASE-5 T8 Step 2, RULING P5-R14).
//
// The registry says what a tool DOES to the world (`effects[]`, T1). This module
// turns that declaration plus the call's real arguments into the resource list
// the capability carries. **All of the interpretation lives here, upstream of
// the facade**, which is what leaves the facade a pure matcher and keeps one
// owner per job (P5-R14 §1).
//
// ── THE THREE `from` SHAPES, AND WHAT EACH YIELDS ──
//   `args.<dotted>`   resolve the argument. `T2's dispatcher can resolve and
//                     authorize an args. effect before the handler runs` — the
//                     committed type's own contract, and the reason this half
//                     needs no ruling.
//   `fixed:<what>`    a constant the tool always touches.
//   `derived:<prose>` resolved inside the handler. **Branch (A):** where the
//                     scope is machine-resolvable it is DECLARED, as a `scope`
//                     sibling on the effect, and enforced by declaration-match
//                     against that scope. **Branch (B):** the genuinely
//                     unresolvable remainder — argv beyond a declared fixed
//                     program — is CARRIED with the capability proving gate-loop
//                     provenance and audited, from an EXPLICIT NAMED LIST, never
//                     a heuristic (`CARRIED_PROGRAMS` below).
//
// A `derived:` effect with no `scope` yields NO grant. That is deliberate and it
// fails closed in the honest direction: an unconverted handler still calls
// `node:fs` directly and is unaffected, and a CONVERTED one cannot quietly
// acquire an unbounded reach — it refuses, loudly, and the refusal is the signal
// that the declaration is owed (P5-R14: blocked until adjudicated, never
// silently refused).
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { canonicalizeAgentPath, resolveRealPathHardened } from '../path-resolve.js';
import { effectsFor } from '../tools/registry.js';
import { resolvePathArg, resolveArgvArg, resolveUrlArg } from '../brokers/resolve.js';
import {
  EFFECT_FROM_ARGS, EFFECT_FROM_FIXED, EFFECT_FROM_DERIVED,
  type ToolEffect, type EffectScope, type EffectIndirection,
} from '../tools/types.js';
import { resolveAttachmentPath } from '../../services/attachment-resolve.js';
import { techniqueDirectory } from '../../techniques/technique-dir.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from './capability.js';

/**
 * PROGRAMS A TOOL LEGITIMATELY SPAWNS WHOSE ARGUMENTS IT BUILDS ITSELF —
 * RULING P5-R14 branch (B), as an explicit named list with a reason per entry.
 *
 * These are the cases where the declaration can name the PROGRAM and nothing
 * honest can be said about the argv before the handler runs. The capability
 * carries the program, which is what proves gate-loop provenance; the argv is
 * audited rather than matched.
 *
 * It is a LIST and not a predicate on purpose: a heuristic ("anything under
 * /usr/bin", "any program whose name is in the description") is how a carried
 * set silently grows. `effects/__tests__/facade-contract.test.ts` holds the
 * census — every entry needs a reason, and a new one has to be written here by
 * hand to exist at all.
 *
 * It starts EMPTY because no converted call site needs one yet: the two exec
 * doors declare `args.argv` / `args.script`, which is branch (A). Entries land
 * with the categories that need them (`plaud/client.ts`'s `npx`,
 * `services/tunnel.ts`'s `cloudflared`, `services/transcription.ts`'s spawn).
 */
export const CARRIED_PROGRAMS: Readonly<Record<string, string>> = {};

/**
 * HOW AN IDENTIFIER ARGUMENT BECOMES A RESOURCE — RULING P5-R15 ADDENDUM
 * mechanic 5, as an explicit named table.
 *
 * `ToolEffect.via` may only point at a key of this object, so a declaration
 * cannot invent an indirection; it can only name one the platform already owns.
 * Each entry is the SAME function the handler resolves with, which is what makes
 * "one resolution point" true rather than hoped: the gate loop and the handler
 * ask the same question of the same reader and get the same answer.
 *
 * This is resolution, not policy. Nothing here decides whether a resource may be
 * touched — the brokers already did, and the facade matches what this returned.
 */
export type IndirectResolver = (id: string) => { path: string } | null;

export const INDIRECT_RESOLVERS: Readonly<Record<EffectIndirection, IndirectResolver>> = {
  /** `transcribe_audio`'s `attachment_id` → the path `messages.attachments` records for it. */
  attachment_row: resolveAttachmentPath,
  /** A technique reference (id, slug or display name) → the `directory_path` its
   *  row records — RULING P5-R15 ADDENDUM 3(1)(a). With `scope: { at: 'argTree' }`
   *  it names the TREE the tool works inside; that is the whole difference from
   *  `attachment_row`, which resolves to one file. */
  technique_dir: techniqueDirectory,
};

// `EffectScope` is declared on the registry leaf (`tools/types.ts`) beside the
// effect it qualifies, so a definition can carry one without importing anything.
// An argument the call did not supply yields NO grant, so a missing argument can
// never widen a scope into its parent.

/** `~/x` → `/Users/me/x`, `<agentId>` → the agent, `{args.a.b}` → that value. */
export function expandScopeTemplate(
  template: string,
  agentId: string,
  args: Record<string, unknown>,
): string | null {
  let out = template.replace(/<agentId>/g, agentId);
  const holes = out.match(/\{args\.[^}]+\}/g) ?? [];
  for (const hole of holes) {
    const dotted = hole.slice('{args.'.length, -1);
    let cursor: unknown = args;
    for (const segment of dotted.split('.')) {
      if (cursor === null || typeof cursor !== 'object') { cursor = undefined; break; }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (typeof cursor !== 'string' || cursor.trim().length === 0) return null;
    // A template hole names ONE path segment. A value carrying a separator or a
    // `..` would let an argument climb out of the scope it is being placed in,
    // which is the traversal class the resolver exists to end.
    if (cursor.includes('/') || cursor.includes('\\') || cursor === '..') return null;
    out = out.replace(hole, cursor);
  }
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) return null;
  return canonicalizeAgentPath(out);
}

function readArgPath(args: Record<string, unknown>, dotted: string): unknown {
  let cursor: unknown = args;
  for (const segment of dotted.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function fsKindOf(kind: string): 'fs_read' | 'fs_write' | 'fs_delete' | null {
  return kind === 'fs_read' || kind === 'fs_write' || kind === 'fs_delete' ? kind : null;
}

/**
 * ONE resolved path becomes ONE grant — a TREE when the declaration says the
 * effect covers what is INSIDE it (`scope: { at: 'argTree' }`), otherwise the
 * single file it names. Written once because both ways of naming a resource —
 * the argument itself, and an argument resolved through a named indirection —
 * mean the same thing once the path is known.
 */
function pushResolved(
  grants: ResourceGrant[], kind: 'fs_read' | 'fs_write' | 'fs_delete',
  value: { lexical: string; real: string }, tree: boolean,
): void {
  if (!tree) {
    grants.push({ kind, at: 'path', lexical: value.lexical, real: value.real });
    return;
  }
  grants.push({ kind, at: 'tree', root: value.lexical });
  if (value.real !== value.lexical) grants.push({ kind, at: 'tree', root: value.real });
}

/**
 * THE RESOURCES THIS CALL IS AUTHORIZED TO TOUCH.
 *
 * Called by the executor's gate loop AFTER every gate has answered, so a refused
 * call never reaches this at all. It decides nothing: every resource here was
 * either named by the agent in an argument the brokers just authorized, or
 * declared on the tool definition.
 */
export function grantsForCall(
  agentId: string,
  effects: readonly ToolEffect[] | undefined,
  args: Record<string, unknown>,
  resolvers: Readonly<Record<EffectIndirection, IndirectResolver>> = INDIRECT_RESOLVERS,
): ResourceGrant[] {
  const grants: ResourceGrant[] = [];
  if (!effects) return grants;

  for (const effect of effects) {
    const fsKind = fsKindOf(effect.kind);

    // ── args.<dotted> ──
    if (effect.from.startsWith(EFFECT_FROM_ARGS)) {
      const dotted = effect.from.slice(EFFECT_FROM_ARGS.length);

      // `via:` — the argument is an IDENTIFIER, and the resource is the path the
      // platform recorded against it (RULING P5-R15 ADDENDUM mechanic 5). The
      // resolver is the same function the handler uses, so the two cannot
      // disagree; an id that resolves to nothing yields NO grant, which leaves
      // the handler's own "no attachment found" message intact rather than
      // turning a stale id into a bare refusal.
      if (effect.via && fsKind) {
        const id = readArgPath(args, dotted);
        if (typeof id !== 'string' || id.trim().length === 0) continue;
        // A `via` the table does not name grants NOTHING rather than throwing.
        // The type already refuses one at compile time; this is the runtime half,
        // and it fails closed — the gate loop must never crash a dispatch over a
        // declaration it cannot interpret.
        const resolve = resolvers[effect.via] as IndirectResolver | undefined;
        if (!resolve) continue;
        const row = resolve(id);
        if (!row) continue;
        const recorded = resolvePathArg(row.path);
        // `argTree` COMPOSES with the indirection: what the reference resolved to
        // is a DIRECTORY and the effect covers what is inside it (ADDENDUM 3(1)(a)
        // — a technique's supporting files). Without it the indirection still
        // names exactly ONE file, which keeps the tree a declaration, not a habit.
        if (recorded.ok) pushResolved(grants, fsKind, recorded.value, effect.scope?.at === 'argTree');
        continue;
      }

      // `args.<name>[]` — EVERY ELEMENT of an array argument, one grant each.
      // Read as a literal key this found no argument called `attachments[]` and
      // yielded NO grant at all, which is fail-closed in the wrong place: it
      // reads as "this tool touches no file" when the tool touches every file in
      // the list, and the first converted site would have refused working
      // behaviour. An element that is not a usable path grants nothing, so a
      // malformed list narrows to what it legitimately named and never widens.
      //
      // `args.<name>[].<prop>` — RULING P5-R15 ADDENDUM 2 mechanic 7. The
      // element is an OBJECT and the path is one of its properties
      // (`pdf_create`'s `content` blocks carry `image { path, … }`, and
      // `office_create_word_document` declares the identical shape). Same family
      // as the bare array mechanic: expressiveness, not policy. An element
      // WITHOUT the property grants nothing for it, so a mixed list — the normal
      // case, since most content blocks are text — narrows to exactly the
      // elements that name a file.
      const arrayAt = dotted.indexOf('[]');
      if (arrayAt !== -1 && fsKind) {
        const list = readArgPath(args, dotted.slice(0, arrayAt));
        const prop = dotted.slice(arrayAt + 2);
        if (Array.isArray(list)) {
          for (const element of list) {
            const named = prop === ''
              ? element
              : readArgPath(element as Record<string, unknown>, prop.startsWith('.') ? prop.slice(1) : prop);
            const resolved = resolvePathArg(named);
            if (resolved.ok) {
              grants.push({ kind: fsKind, at: 'path', lexical: resolved.value.lexical, real: resolved.value.real });
            }
          }
        }
        continue;
      }

      const raw = readArgPath(args, dotted);
      if (fsKind) {
        const resolved = resolvePathArg(raw);
        // `scope: { at: 'argTree' }` — the argument names a DIRECTORY and the
        // effect covers what is inside it (`file_list` stats every entry). The
        // root is the resolved argument, so this can never be wider than the
        // directory the agent named and the gate loop already authorized.
        if (resolved.ok) pushResolved(grants, fsKind, resolved.value, effect.scope?.at === 'argTree');
      } else if (effect.kind === 'proc') {
        const resolved = resolveArgvArg(raw);
        if (resolved.ok) {
          grants.push({ kind: 'proc', program: resolved.value.program, display: resolved.value.display });
        }
      } else if (effect.kind === 'shell') {
        // The shell door hands its script to ONE interpreter; the script text is
        // what the broker authorized and what the audit row carries.
        grants.push({ kind: 'shell', program: '/bin/zsh', display: typeof raw === 'string' ? raw : '' });
      } else if (effect.kind === 'net') {
        const resolved = resolveUrlArg(raw);
        if (resolved.ok) grants.push({ kind: 'net', host: resolved.value.hostname });
      }
      continue;
    }

    // ── fixed:<what> ──
    if (effect.from.startsWith(EFFECT_FROM_FIXED)) {
      const what = effect.from.slice(EFFECT_FROM_FIXED.length);
      if (effect.kind === 'net') grants.push({ kind: 'net', host: what });
      else if (fsKind) {
        const abs = expandScopeTemplate(what, agentId, args);
        if (abs) grants.push({ kind: fsKind, at: 'path', lexical: abs, real: resolveRealPathHardened(abs).path });
      }
      continue;
    }

    // ── derived:<prose> + the declared machine-checkable scope ──
    if (effect.from.startsWith(EFFECT_FROM_DERIVED)) {
      const scope: EffectScope | undefined = effect.scope;
      if (!scope) continue; // branch (A) not declared yet → no grant, fail closed
      if (scope.at === 'program') {
        if (CARRIED_PROGRAMS[scope.program] === undefined) continue;
        grants.push({ kind: 'proc', program: scope.program, display: scope.program });
        continue;
      }
      // `argTree` qualifies an `args.` effect and has no template of its own, so
      // a `derived:` effect carrying it names no resource at all — no grant,
      // fail closed, exactly as a `derived:` with no scope does.
      if (scope.at === 'argTree') continue;
      const abs = expandScopeTemplate(scope.template, agentId, args);
      if (!abs || !fsKind) continue;
      if (scope.at === 'tree') grants.push({ kind: fsKind, at: 'tree', root: abs });
      else grants.push({ kind: fsKind, at: 'path', lexical: abs, real: resolveRealPathHardened(abs).path });
    }
  }

  return grants;
}

/**
 * THE DOOR THE EXECUTOR CALLS, once, after every gate has answered and none
 * refused.
 *
 * It lives here rather than in the executor because this is where the
 * interpretation is: what a declaration MEANS is this module's job, and the
 * dispatcher's job is to have decided. One line at the call site is also the
 * honest shape — the gate loop gains a step, not a mechanism.
 */
export function openCallCapability(
  agentId: string,
  tool: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  attachCallCapability(mintCallCapability({
    agentId, tool, callId, grants: grantsForCall(agentId, effectsFor(tool), args),
  }));
}
