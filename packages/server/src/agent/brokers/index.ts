// The brokers' public surface: it re-exports each effect's own authorizer (fs, proc, applescript,
// net, exec-seam) with the grant and deny-rule helpers, and defines the two grant checks that
// have no file of their own (`authorizeSpawn`, `authorizeSystemControl`). Each caller picks the
// authorizer for its effect; there is no single dispatching door.

import { evaluateRules, type Grant } from './grants.js';
import { allow, deny, type Verdict } from './types.js';

export type { Verdict, BrokerEffect, VerdictBasis } from './types.js';
export type { Grant, GrantRule, GrantEffectKind, GrantMode } from './grants.js';
export { grantFor, grantForManifest, syncGrantRules, projectManifestToRules } from './grants.js';
export {
  resolvePathArg, resolveCommandArg, resolveArgvArg, resolveUrlArg, resolveFixedHost,
  type ResolvedPath, type ResolvedCommand, type ResolvedArgv, type ResolvedUrl, type Resolution,
} from './resolve.js';
export { authorizeFs, globalDeny, shareDeny } from './fs.js';
export {
  authorizeProc, authorizeArgv, authorizeShellScript,
  commandReadsSensitiveFile, argvReadsSensitiveFile,
} from './proc.js';
export { authorizeAppleScript } from './applescript.js';
export {
  authorizeExecShapedCall, authorizeExecShapedArgs, execCallText, execDoorFor,
  EXEC_DOOR_ARG, type ExecDoor,
} from './exec-seam.js';
export { authorizeNet, authorizeNetDomain } from './net.js';
export {
  DENY_RULES, denyRuleFor, tiersForKind,
  isSensitivePath,
  type DenyRule, type DenyTier,
} from './deny.js';

/** `can_spawn_agents`, as a grant row. */
export function authorizeSpawn(grant: Grant): Verdict {
  const verdict = evaluateRules(grant, 'spawn', () => true);
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny('ladder-parity', 'no-spawn-grant', 'Agent spawning is not permitted');
}

/** `system_control`, as grant rows: a manifest may name the category, the tool, or `'*'`,
 *  as the ladder's category derivation did (mouse, keyboard, screen, applescript). */
export function authorizeSystemControl(grant: Grant, category: string, toolName: string): Verdict {
  const verdict = evaluateRules(grant, 'system_control', (pattern) =>
    pattern === '*' || pattern === category || pattern === toolName);
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  return deny('ladder-parity', 'no-system-control-grant', `system_control permission required: ${category}`);
}

/** THE SYSTEM-CONTROL CLASSES, declared rather than inferred from a string compare:
 *  the enumeration every gated tool maps onto, held by `system-control.test.ts`. */
export const SYSTEM_CONTROL_CLASSES = ['mouse', 'keyboard', 'screen', 'applescript'] as const;
