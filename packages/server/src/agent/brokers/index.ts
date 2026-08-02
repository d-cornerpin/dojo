// ════════════════════════════════════════════════════════════════════════════
// `authorize(grant, effect)` — ONE DOOR (PHASE-5 T2 Step 2).
//
// The plan's whole sentence for this phase: *"Locks move from a name-ladder at
// one entrance to `authorize(grant, effect)` at the actual doors."* This is that
// function. It takes a GRANT (rows, deny before allow) and an EFFECT (a kind and
// a RESOLVED resource) and answers with a verdict that names the rule it used.
//
// It is async because one kind — `net` — genuinely needs DNS to answer the SSRF
// question, and pretending otherwise would have meant either a second entry
// point or a weaker answer. Every other kind resolves without I/O; the sync
// cores are exported by their own modules for `checkPermission`'s legacy shape.
// ════════════════════════════════════════════════════════════════════════════

import { authorizeFs } from './fs.js';
import { authorizeProc } from './proc.js';
import { authorizeNet } from './net.js';
import { evaluateRules, type Grant } from './grants.js';
import { allow, deny, type Verdict } from './types.js';
import type { BrokerEffect } from './types.js';

export type { Verdict, BrokerEffect, VerdictBasis } from './types.js';
export type { Grant, GrantRule, GrantEffectKind, GrantMode } from './grants.js';
export { grantFor, grantForManifest, syncGrantRules, forgetGrant, projectManifestToRules } from './grants.js';
export {
  resolvePathArg, resolveCommandArg, resolveUrlArg, resolveFixedHost,
  type ResolvedPath, type ResolvedCommand, type ResolvedUrl, type Resolution,
} from './resolve.js';
export { authorizeFs, globalDeny, shareDeny } from './fs.js';
export { authorizeProc, commandReadsSensitiveFile } from './proc.js';
export { authorizeNet, authorizeNetDomain } from './net.js';
export {
  DENY_RULES, deniedTiers, denyRuleFor, isDeniedResource, tiersForKind,
  isSensitivePath, isGlobalReadDenied, isGlobalWriteDenied, isGlobalDeleteDenied,
  type DenyRule, type DenyTier,
} from './deny.js';

/** `can_spawn_agents`, as a grant row. Branch 4's requirement. */
export function authorizeSpawn(grant: Grant): Verdict {
  const verdict = evaluateRules(grant, 'spawn', () => true);
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny('ladder-parity', 'no-spawn-grant', 'Agent spawning is not permitted');
}

/**
 * `system_control`, as grant rows. Branches 14a and 15's requirement — including
 * branch 15's CATEGORY derivation (`mouse` / `keyboard` / `screen` /
 * `applescript`), which is the decomposition T3 Step 2 owes and which this gate
 * already honours because the ladder did: a manifest may name the category, the
 * tool, or `'*'`.
 */
export function authorizeSystemControl(grant: Grant, category: string, toolName: string): Verdict {
  const verdict = evaluateRules(grant, 'system_control', (pattern) =>
    pattern === '*' || pattern === category || pattern === toolName);
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny('ladder-parity', 'no-system-control-grant', `system_control permission required: ${category}`);
}

/** THE DOOR. */
export async function authorize(grant: Grant, effect: BrokerEffect): Promise<Verdict> {
  switch (effect.kind) {
    case 'fs_read':
    case 'fs_write':
    case 'fs_delete':
      return authorizeFs(grant, effect.kind, effect.resource, effect.surface ?? 'tool');
    case 'shell':
    case 'proc':
      return authorizeProc(grant, effect.resource, true);
    case 'net':
      return authorizeNet(grant, effect.resource);
    case 'spawn':
      return authorizeSpawn(grant);
  }
}
