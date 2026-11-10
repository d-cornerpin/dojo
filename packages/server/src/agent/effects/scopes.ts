// FROM DECLARATION TO RESOLVED RESOURCE: the registry says what a tool DOES (`effects[]`); this plus the
// call's real arguments become the resource list the capability carries. ALL interpretation lives here,
// upstream of the facade, which is what leaves the facade a pure matcher with one owner per job.
// `args.<dotted>` resolves the argument; `fixed:<what>` is a constant the tool always touches;
// `derived:<prose>` is a declared `scope` sibling (machine-checked) or the CARRIED remainder beyond a
// fixed program's argv, audited from an EXPLICIT NAMED LIST. A `derived:` with no `scope` yields NO grant.

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
import { canvasFilePath } from '../canvas-state.js';
import { localPathFromFileId } from '../../microsoft/office-local-path.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from './capability.js';
import { homeDir } from '../../home.js';

// PROGRAMS A TOOL LEGITIMATELY SPAWNS whose argv it builds itself: the capability carries the program
// (gate-loop provenance) and the argv is audited, not matched. A LIST, not a predicate; a census holds it.
export const CARRIED_PROGRAMS: Readonly<Record<string, string>> = {
  ffmpeg: 'the transcoder transcribe_audio spawns to reach 16 kHz mono PCM WAV; its argv is two platform-generated temp paths, so the PROGRAM is what the declaration can honestly name',
  /** Keyed by the ABSOLUTE path the process door is asked for; one call site (`inspect/sql-child.ts`). */
  [process.execPath]: 'node, for dojo_inspect\'s sql view: argv is the fixed inline child source; the query is stdin data, run on a read-only connection',
};

// HOW AN IDENTIFIER BECOMES A RESOURCE, as an explicit named table: `via` may only name a key here, so a
// declaration cannot invent one. Each entry is the handler's own resolver; this is resolution, not policy.
export type IndirectResolver = (id: string) => { path: string } | null;

export const INDIRECT_RESOLVERS: Readonly<Record<EffectIndirection, IndirectResolver>> = {
  attachment_row: resolveAttachmentPath,
  technique_dir: techniqueDirectory,
  agent_canvas_file: canvasFilePath,
  /** A local document in `path` OR in `file_id`; a genuine cloud id mints no fs grant. */
  office_local_path: localPathFromFileId,
};

// EffectScope lives on the registry leaf; an argument the call did not supply yields NO grant.

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
    // A hole names ONE path segment: a separator or `..` would climb out of the scope it is placed in.
    if (cursor.includes('/') || cursor.includes('\\') || cursor === '..') return null;
    out = out.replace(hole, cursor);
  }
  if (out.startsWith('~')) out = path.join(homeDir(), out.slice(1));
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

/** ONE resolved path makes ONE grant: a tree if the effect covers its inside (argTree), else a file. */
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

/** THE RESOURCES THIS CALL MAY TOUCH: built after every gate answered; it decides nothing. */
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

    if (effect.from.startsWith(EFFECT_FROM_ARGS)) {
      const dotted = effect.from.slice(EFFECT_FROM_ARGS.length);

      // `via:`: the argument is an IDENTIFIER and the resource is the path the platform recorded for it.
      if (effect.via && fsKind) {
        const id = readArgPath(args, dotted);
        if (typeof id !== 'string' || id.trim().length === 0) continue;
        // A `via` not in the table, or nothing recorded: NO grant, fail closed; the handler's message stands.
        const resolve = resolvers[effect.via] as IndirectResolver | undefined;
        if (!resolve) continue;
        const row = resolve(id);
        if (!row) continue;
        const recorded = resolvePathArg(row.path);
        // `argTree` COMPOSES with the indirection: the resolved directory becomes the TREE, else one file.
        if (recorded.ok) pushResolved(grants, fsKind, recorded.value, effect.scope?.at === 'argTree');
        continue;
      }

      // `args.<name>[]`: EVERY ELEMENT, one grant each; `args.<name>[].<prop>`: the element is an OBJECT and
      // the path is that property. Anything not a usable path grants nothing: a list narrows, never widens.
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
        // `argTree`: the argument names a DIRECTORY and the effect covers inside it; never wider than it.
        if (resolved.ok) pushResolved(grants, fsKind, resolved.value, effect.scope?.at === 'argTree');
      } else if (effect.kind === 'proc') {
        const resolved = resolveArgvArg(raw);
        if (resolved.ok) {
          grants.push({ kind: 'proc', program: resolved.value.program, display: resolved.value.display });
        }
      } else if (effect.kind === 'shell') {
        // The shell door hands its script to ONE interpreter; the script text is what the broker authorized.
        grants.push({ kind: 'shell', program: '/bin/zsh', display: typeof raw === 'string' ? raw : '' });
      } else if (effect.kind === 'net') {
        const resolved = resolveUrlArg(raw);
        if (resolved.ok) grants.push({ kind: 'net', host: resolved.value.hostname });
      }
      continue;
    }

    if (effect.from.startsWith(EFFECT_FROM_FIXED)) {
      const what = effect.from.slice(EFFECT_FROM_FIXED.length);
      if (effect.kind === 'net') grants.push({ kind: 'net', host: what });
      else if (fsKind) {
        const abs = expandScopeTemplate(what, agentId, args);
        if (abs) grants.push({ kind: fsKind, at: 'path', lexical: abs, real: resolveRealPathHardened(abs).path });
      }
      continue;
    }

    if (effect.from.startsWith(EFFECT_FROM_DERIVED)) {
      const scope: EffectScope | undefined = effect.scope;
      if (!scope) continue; // branch (A) not declared yet → no grant, fail closed
      // The CALL'S OWN AGENT IDENTITY is the key: no argument names it, the platform recorded it earlier.
      if (scope.at === 'agentResolved') {
        const resolve = resolvers[scope.via] as IndirectResolver | undefined;
        const row = resolve ? resolve(agentId) : null;
        if (!row || !fsKind) continue;
        const recorded = resolvePathArg(row.path);
        if (recorded.ok) pushResolved(grants, fsKind, recorded.value, false);
        continue;
      }
      if (scope.at === 'program') {
        if (CARRIED_PROGRAMS[scope.program] === undefined) continue;
        grants.push({ kind: 'proc', program: scope.program, display: scope.program });
        continue;
      }
      // `argTree` qualifies an `args.` effect and names no resource of its own: on `derived:`, no grant.
      if (scope.at === 'argTree') continue;
      const abs = expandScopeTemplate(scope.template, agentId, args);
      if (!abs || !fsKind) continue;
      if (scope.at === 'tree') grants.push({ kind: fsKind, at: 'tree', root: abs });
      else grants.push({ kind: fsKind, at: 'path', lexical: abs, real: resolveRealPathHardened(abs).path });
    }
  }

  return grants;
}

/** THE DOOR THE EXECUTOR CALLS, once all gates answered: interpreting declarations is this module's job. */
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
