// ════════════════════════════════════════════════════════════════════════════
// SCOPE — VALIDATED, SUBSET-OF-PARENT, READABLE (PHASE-5 T5).
//
// `manifest.ts` holds what a grant IS and how a stored one is read. This module
// holds the three things T5 owes on top of it, and they are deliberately in one
// file because they are one job — deciding what a manifest is allowed to say:
//
//   VALIDATED       a stored or supplied manifest is checked against a schema,
//                   and a MALFORMED one REFUSES the spawn rather than silently
//                   downgrading to the default. A silent downgrade is how an
//                   agent ends up with a scope nobody chose.
//   SUBSET          a child cannot exceed its parent, structurally.
//                   `can_assign_permissions` gates DELEGATION — handing a child
//                   some of what you hold — never ESCALATION.
//   READABLE        the effective scope is derivable on demand, so
//                   `GET /api/agents/:id` can answer "what can this agent
//                   actually do" without anybody reconstructing it.
//
// ── THE DEFAULT: INHERIT PARENT MINUS DANGER (owner, DECIDED 2026-07-26) ──
// A spawned worker's default scope is its parent's effective scope MINUS the
// danger set — destructive tools, system control, messaging/outbound-send —
// each of which needs an explicit parent grant per spawn. That decision is the
// owner's and is executed here, not re-asked.
//
// ⚠ WHAT THE DANGER SET MAPS ONTO WAS MEASURED, AND TWO OF ITS THREE MEMBERS
// TURNED OUT TO BE ALREADY WITHHELD FROM EVERY SUB-AGENT. This matters, because
// the alternative was inventing a gate:
//
//   system control        THE ONE THAT ACTUALLY CHANGES. Today a child inherits
//                         its parent's manifest verbatim, so a child of the
//                         primary receives `system_control:['*']` — and two live
//                         sub-agents on the dev body hold exactly that, by
//                         inheritance. This is what `system_control: []` below
//                         stops, for NEW spawns.
//   destructive tools     already held: `destructive-gate.ts` routes EVERY
//                         non-primary agent's destructive call to the primary
//                         for approval, and `file_delete` is the only
//                         destructive thing a manifest can say. Set to 'none'
//                         here so the manifest states what is already true.
//   messaging / outbound  already held, at four walls: `imessage_send` by gate
//                         row 7, and `sms_send` / `voice_call` /
//                         `voice_call_end` / `voice_call_status` by their own
//                         handler-body primary-only checks. There is NO manifest
//                         field for it and this module does not invent one —
//                         building a new gate would newly refuse calls that work
//                         today, which is the owner's decision and not a
//                         worker's (RULING P5-R5). `__tests__/child-scope.test.ts`
//                         holds the four walls instead, so the class stays
//                         withheld by something that can fail.
//
// ⚠ AND WHAT IS DELIBERATELY *NOT* STRIPPED, each with its reason:
//   exec / shell          shell and pipes are NOT in the danger set the owner
//                         named (plan T5 INBOUND (c)). A default sub-agent
//                         already runs `ls | wc -l` and `for f in *; …` today,
//                         and withholding `shell_allow` by default would be a
//                         narrowing this task's own ruling does not authorize.
//   network               not in the danger set, and the plan calls the old
//                         `network:'none'` default a FALSE STATEMENT — workers
//                         must browse. A child inherits the parent's reach.
//   can_spawn_agents      not named as danger, and a child of the primary holds
//                         it today. Stripping it would narrow.
//   can_assign_permissions  same, and it is now bounded by the subset rule
//                         below, which is what makes leaving it safe.
// ════════════════════════════════════════════════════════════════════════════

import { z } from 'zod';
import type { PermissionManifest } from '@dojo/shared';
import { DEFAULT_SUBAGENT_PERMISSIONS, withArtifactPaths, artifactPathFor } from './manifest.js';

// ── The schema ──

// `'none'` is accepted on the READ/WRITE fields as well as on `file_delete`,
// because live manifests use it: the dev body's PM agent stores
// `file_write:"none"` and the projection has always honoured it (neither `'*'`
// nor an array yields any allow row, so it means deny-all). Refusing it here
// would have made the validator reject a manifest the platform wrote itself —
// a capability loss wearing a schema's clothes, caught by this module's own
// positive test rather than in production.
const pathList = z.union([z.literal('*'), z.literal('none'), z.array(z.string())]);

/**
 * The manifest schema, mirroring `PermissionManifest` in `@dojo/shared`.
 *
 * `system_control` accepts the scalar `'*'` as well as a list because a stored
 * manifest legitimately holds either — the ladder's branch 14/15 read it both
 * ways and `projectManifestToRules` still does. Accepting only the array here
 * would make the validator REFUSE manifests the platform has always honoured,
 * which is a capability loss wearing a schema's clothes.
 *
 * Everything is `.optional()` except nothing: a partial manifest is a legitimate
 * stored shape (`getAgentPermissions` fills each missing field from the default,
 * and 40 of 56 agents on the dev body store `'{}'`). What this schema refuses is
 * a field of the WRONG TYPE — `file_read: 42`, `exec_allow: "ls"` — which is the
 * shape that produces a silent downgrade today.
 */
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

/**
 * Validate a manifest that arrived as an OBJECT (a spawn argument, an API body).
 *
 * Returns the reason rather than throwing, so each caller decides what a refusal
 * looks like on its own surface — a thrown spawn error, a 400, a log line.
 */
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

/**
 * Validate a manifest that arrived as STORED TEXT.
 *
 * ⚠ A MALFORMED MANIFEST IS A REFUSAL, NEVER A SILENT DOWNGRADE — that is the
 * whole point of this function existing beside `getAgentPermissions`. The reader
 * in `manifest.ts` catches a JSON error and falls back to the default, which is
 * right for a READ (refusing every tool call because a blob is corrupt would take
 * an agent off the air). It is wrong for a SPAWN: writing a child a scope nobody
 * chose, and calling it the default, is how an agent silently ends up with more
 * or less than its creator asked for.
 */
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

// ── The default child scope ──

export { artifactPathFor };

/**
 * THE DECIDED DEFAULT (owner, 2026-07-26): a spawned worker's scope is its
 * parent's effective scope MINUS the danger set.
 *
 * Applied ONLY when the spawn does not name a manifest. A spawn that names one
 * gets what it named, bounded by the subset rule.
 *
 * ⚠ PROSPECTIVE, NEVER RETROSPECTIVE. This decides what a NEW child receives. It
 * is not applied to agents that already exist, and migration 155 deliberately
 * does not re-scope anybody: an agent alive today keeps exactly the scope it has.
 * The owner decided the default for future spawns; re-scoping the living was not
 * on the table and would be a narrowing nobody asked for.
 */
export function defaultChildScope(parent: PermissionManifest, childId: string): PermissionManifest {
  return {
    // Inherited, plus the child's own artifact directory — the missing path that
    // T2's staging window was opened for in the first place.
    ...withArtifactPaths(parent, childId),
    // DANGER: destructive. `file_delete` is the only destructive thing a manifest
    // can say, and every non-primary destructive call is already held for the
    // primary's approval by `destructive-gate.ts`.
    file_delete: 'none',
    // DANGER: system control — the one member of the set that actually changes
    // what a new child receives. It carries AppleScript with it, because after
    // this task's projection flip an AppleScript grant must be NAMED and an
    // empty list names nothing.
    system_control: [],
  };
}

/**
 * The stock default for an agent with no stored manifest, with its own artifact
 * directory filled in. `DEFAULT_SUBAGENT_PERMISSIONS` cannot carry it as a
 * constant because the path contains the agent's id.
 */
export function defaultScopeFor(agentId: string): PermissionManifest {
  return withArtifactPaths(DEFAULT_SUBAGENT_PERMISSIONS, agentId);
}

// ── Child ⊆ parent ──

/**
 * Does `child` stay inside `parent` for one path- or command-shaped field?
 *
 * ⚠ `'*'` IS ALSO A LIST MEMBER, and forgetting that was a real defect this
 * module's own positive control caught: `PRIMARY_AGENT_PERMISSIONS.exec_allow`
 * is `['*']`, not the scalar `'*'`, so a naive `parent.includes(entry)` refused
 * the primary's own children the right to run `ls`. A parent list holding `'*'`
 * holds everything, exactly as `matchCommandPattern` reads it at the broker.
 */
function pathSubset(child: string[] | '*' | 'none', parent: string[] | '*' | 'none'): boolean {
  if (child === 'none') return true;          // nothing is always inside anything
  if (parent === '*') return true;            // everything contains everything
  if (Array.isArray(parent) && parent.includes('*')) return true;
  if (child === '*') return false;            // '*' inside a bounded list is an escalation
  if (parent === 'none') return false;        // a list inside nothing is an escalation
  if (Array.isArray(child) && child.length === 0) return true;
  return child.every((p) => parent.includes(p));
}

function domainSubset(child: PermissionManifest['network_domains'], parent: PermissionManifest['network_domains']): boolean {
  if (child === 'none') return true;
  if (parent === '*') return true;
  if (Array.isArray(parent) && parent.includes('*')) return true;
  if (child === '*') return false;
  if (parent === 'none') return false;
  if (Array.isArray(child) && child.length === 0) return true;
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
  // A parent holding `'*'` inside its list holds every category, which is what
  // `'*'` has always meant — except AppleScript, which since this task must be
  // named. So `'*'` in the parent covers any child entry EXCEPT applescript.
  const parentHasStar = p.includes('*');
  return c.every((entry) =>
    p.includes(entry) || (parentHasStar && entry !== 'applescript' && entry !== 'applescript_run'));
}

/**
 * EVERY WAY `child` EXCEEDS `parent`, named.
 *
 * A list rather than a boolean because the refusal has to tell the caller which
 * field to fix; "permission denied" with no field is a message a model cannot
 * act on, and this is the same lesson T3C's validator messages landed.
 *
 * `can_assign_permissions` is NOT consulted as a bypass. It gates DELEGATION —
 * whether an agent may hand a child a manifest at all — and the plan is explicit
 * that it "gates delegation, not escalation". An agent holding it can give away
 * any subset of what it has; it can never mint more.
 */
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

/**
 * THE ONE ENTRY POINT A SPAWN USES.
 *
 * Given what the caller asked for (or nothing) and the parent's effective scope,
 * answer with the manifest to store — or with the reason to refuse.
 */
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
  // What the caller named, over the default it did not. Fields the caller left
  // out fall back to the minus-danger default rather than to the parent's own
  // manifest, so omitting a field can never be a way to inherit danger.
  return { ok: true, manifest: { ...defaultChildScope(parent, childId), ...validated.manifest } as PermissionManifest };
}
