// SCOPE: VALIDATED, SUBSET-OF-PARENT, READABLE (effective scope derivable on demand for the API).
// VALIDATED: a malformed manifest REFUSES the spawn; a silent downgrade writes a scope nobody chose.
// SUBSET: a child cannot exceed its parent. can_assign_permissions gates delegation, never escalation.
// Default: the parent's effective scope MINUS the danger set (destructive, system_control, outbound).
// Destructive and outbound are already withheld elsewhere; system_control is what changes here.
// Not stripped (outside the danger set; stripping would narrow today's behavior): exec/shell, network,
// can_spawn_agents. No outbound manifest field: a new gate would refuse working calls; child-scope.test.ts
// holds the walls. can_assign_permissions is bounded by subset.

import { z } from 'zod';
import type { PermissionManifest } from '@dojo/shared';
import { DEFAULT_SUBAGENT_PERMISSIONS, withArtifactPaths, artifactPathFor } from './manifest.js';

// 'none' is valid on read/write fields: the validator must not refuse a manifest the platform wrote itself.
const pathList = z.union([z.literal('*'), z.literal('none'), z.array(z.string())]);

// Mirrors PermissionManifest; system_control takes the scalar '*' too, since stored manifests hold either.
export const manifestSchema = z.object({
  file_read: pathList.optional(),
  file_write: pathList.optional(),
  file_delete: z.union([z.literal('none'), z.array(z.string())]).optional(),
  exec_allow: z.array(z.string()).optional(),
  exec_deny: z.array(z.string()).optional(),
  shell_allow: z.array(z.string()).optional(),
  shell_deny: z.array(z.string()).optional(),
  network_domains: z.union([z.literal('*'), z.literal('none'), z.array(z.string())]).optional(),
  max_processes: z.number().int().nonnegative().optional(),
  can_spawn_agents: z.boolean().optional(),
  can_assign_permissions: z.boolean().optional(),
  system_control: z.union([z.literal('*'), z.array(z.string())]).optional(),
}).strict();

export type ManifestInput = z.infer<typeof manifestSchema>;

export type ParseResult =
  | { readonly ok: true; readonly manifest: ManifestInput }
  | { readonly ok: false; readonly reason: string };

// Validate an object manifest; return the reason instead of throwing so callers shape their own refusal.
export function validateManifest(raw: unknown): ParseResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'manifest is missing' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `manifest must be a JSON object, received ${Array.isArray(raw) ? 'an array' : typeof raw}` };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: problems };
  }
  return { ok: true, manifest: parsed.data };
}

// A malformed stored manifest is a REFUSAL here, never a silent downgrade.
// The manifest.ts reader may default on a READ; a spawn must not inherit an unchosen scope.
export function parseStoredManifest(raw: string | null | undefined): ParseResult {
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'manifest is empty' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `manifest is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  return validateManifest(value);
}

export { artifactPathFor };

// Decided default: the parent's scope MINUS the danger set, applied only when the spawn names no manifest.
// Prospective only: existing agents keep exactly their current scope.
export function defaultChildScope(parent: PermissionManifest, childId: string): PermissionManifest {
  return {
    // Inherited, plus the child's own artifact directory.
    ...withArtifactPaths(parent, childId),
    // DANGER destructive: file_delete is all a manifest can say; the gate already holds it.
    file_delete: 'none',
    // DANGER system_control: the member that changes; empty names nothing, AppleScript included.
    system_control: [],
  };
}

export function defaultScopeFor(agentId: string): PermissionManifest {
  return withArtifactPaths(DEFAULT_SUBAGENT_PERMISSIONS, agentId);
}

// A parent list holding '*' holds everything, exactly as the broker's matchCommandPattern reads it.
// 'none' and [] both deny all: emptiness is tested once, at the top, before any parent question.
function pathSubset(child: string[] | '*' | 'none', parent: string[] | '*' | 'none'): boolean {
  if (requestsNothing(child)) return true;    // nothing is always inside anything
  if (parent === '*') return true;            // everything contains everything
  if (Array.isArray(parent) && parent.includes('*')) return true;
  if (child === '*') return false;            // '*' inside a bounded list is an escalation
  if (parent === 'none') return false;        // a NON-EMPTY list inside nothing is an escalation
  return child.every((p) => parent.includes(p));
}

/** The two spellings of "grants nothing", said once. See `pathSubset`'s note. */
function requestsNothing(v: string[] | '*' | 'none'): v is 'none' | [] {
  return v === 'none' || (Array.isArray(v) && v.length === 0);
}

function domainSubset(child: PermissionManifest['network_domains'], parent: PermissionManifest['network_domains']): boolean {
  if (requestsNothing(child)) return true;
  if (parent === '*') return true;
  if (Array.isArray(parent) && parent.includes('*')) return true;
  if (child === '*') return false;
  if (parent === 'none') return false;
  return child.every((d) => parent.includes(d));
}

function controlSubset(child: unknown, parent: unknown): boolean {
  const asList = (v: unknown): string[] | '*' =>
    v === '*' ? '*' : Array.isArray(v) ? (v as string[]) : [];
  const c = asList(child);
  const p = asList(parent);
  if (Array.isArray(c) && c.length === 0) return true;
  if (p === '*') return true;
  if (c === '*') return false;
  if (!Array.isArray(p)) return false;
  // A parent '*' in its list covers every category except applescript, which must be named.
  const parentHasStar = p.includes('*');
  return c.every((entry) =>
    p.includes(entry) || (parentHasStar && entry !== 'applescript' && entry !== 'applescript_run'));
}

// Every way child exceeds parent, named: a refusal must say which field to fix, or a model can't act.
// can_assign_permissions is no bypass: it gates delegation, never escalation.
export function scopeExcesses(child: ManifestInput, parent: PermissionManifest): string[] {
  const out: string[] = [];
  const check = (ok: boolean, field: string, detail: string): void => {
    if (!ok) out.push(`${field}: ${detail}`);
  };

  if (child.file_read !== undefined) {
    check(pathSubset(child.file_read, parent.file_read), 'file_read', 'child requests paths its parent cannot read');
  }
  if (child.file_write !== undefined) {
    check(pathSubset(child.file_write, parent.file_write), 'file_write', 'child requests paths its parent cannot write');
  }
  if (child.file_delete !== undefined) {
    check(pathSubset(child.file_delete, parent.file_delete), 'file_delete', 'child requests deletion its parent cannot perform');
  }
  if (child.exec_allow !== undefined) {
    check(pathSubset(child.exec_allow, parent.exec_allow), 'exec_allow', 'child requests commands its parent cannot run');
  }
  if (child.shell_allow !== undefined) {
    const parentShell = parent.shell_allow ?? parent.exec_allow;
    check(pathSubset(child.shell_allow, parentShell), 'shell_allow', 'child requests shell commands its parent cannot run');
  }
  if (child.network_domains !== undefined) {
    check(domainSubset(child.network_domains, parent.network_domains), 'network_domains', 'child requests domains its parent cannot reach');
  }
  if (child.system_control !== undefined) {
    check(controlSubset(child.system_control, parent.system_control), 'system_control', 'child requests system control its parent does not hold');
  }
  if (child.max_processes !== undefined) {
    check(child.max_processes <= parent.max_processes, 'max_processes', `child requests ${child.max_processes}, parent holds ${parent.max_processes}`);
  }
  if (child.can_spawn_agents) {
    check(parent.can_spawn_agents === true, 'can_spawn_agents', 'parent cannot spawn, so its child cannot either');
  }
  if (child.can_assign_permissions) {
    check(parent.can_assign_permissions === true, 'can_assign_permissions', 'parent cannot assign permissions, so its child cannot either');
  }
  return out;
}

// THE ONE ENTRY POINT A SPAWN USES:
// given what was asked and the parent's scope, the manifest to store, or the reason to refuse.
export function resolveChildScope(
  requested: unknown,
  parent: PermissionManifest,
  childId: string,
): { ok: true; manifest: PermissionManifest } | { ok: false; reason: string } {
  if (requested === undefined || requested === null) {
    return { ok: true, manifest: defaultChildScope(parent, childId) };
  }
  const validated = validateManifest(requested);
  if (!validated.ok) {
    return { ok: false, reason: `invalid permission manifest — ${validated.reason}` };
  }
  const excesses = scopeExcesses(validated.manifest, parent);
  if (excesses.length > 0) {
    return {
      ok: false,
      reason: `a sub-agent cannot exceed its parent's scope — ${excesses.join('; ')}`,
    };
  }
  // Omitted fields take the minus-danger default, not the parent's, so omission cannot inherit danger.
  return { ok: true, manifest: { ...defaultChildScope(parent, childId), ...validated.manifest } as PermissionManifest };
}
