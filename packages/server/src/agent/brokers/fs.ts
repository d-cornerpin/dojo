// One door for "may this agent touch this path?", asked of a RESOLVED path so the
// answer cannot be about a different file from the one that opens. The stages run in a
// fixed order (global deny, trainer write-deny, grant rows, squad fallback), and that
// order is the guarantee: a later stage never re-opens what an earlier stage shut.

import { isTrainerAgent, isHealerAgent } from '../../config/platform.js';
import { isProtectedIdentityPath } from '../path-resolve.js';
import { ownsTheMac } from '../owns-the-mac.js';
import { hasSquadWorkspaceAccess } from '../squad-workspace.js';
import { denyRuleFor, tiersForKind, isSensitivePath, type DenyTier, type DenyViewerArg } from './deny.js';
import { evaluateRules, matchPathPattern, type Grant, type GrantEffectKind } from './grants.js';
import type { ResolvedPath } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

export type FsKind = 'fs_read' | 'fs_write' | 'fs_delete';

/** The per-kind refusal wording; a Healer-log read names the bounded helper tools instead. */
function globalDenyReason(kind: FsKind, tier: DenyTier, rawPath: string, ruleId: string): string {
  if (tier === 'sensitive') {
    return `${rawPath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials)`;
  }
  if (kind === 'fs_read' && !ruleId.startsWith('healer-')) return `Global deny: reading ${rawPath} is prohibited`;
  if (kind === 'fs_read') {
    return `Global deny: ${rawPath} is restricted. Use the engine helper tools (healer_recent_actions / healer_action_detail) to access this kind of data with bounded response size.`;
  }
  if (kind === 'fs_write') return `Global deny: writing to ${rawPath} is prohibited`;
  return `Global deny: deleting ${rawPath} is prohibited`;
}

const GRANT_KIND: Record<FsKind, GrantEffectKind> = {
  fs_read: 'fs_read',
  fs_write: 'fs_write',
  fs_delete: 'fs_delete',
};

/** Stage 1, isolated so the tool surface and the SHARE surface ask the same question;
 *  null when nothing denies. Both the lexical and resolved spellings are asked. */
export function globalDeny(kind: FsKind, resource: ResolvedPath, viewer?: DenyViewerArg): Verdict | null {
  for (const tier of tiersForKind(kind)) {
    const lexicalRule = denyRuleFor(resource.lexical, tier, viewer);
    if (lexicalRule) {
      const basis = lexicalRule.since === 'legacy' ? 'ladder-parity' : 'bypass-hardening';
      return deny(basis, lexicalRule.id, globalDenyReason(kind, tier, resource.raw, lexicalRule.id));
    }
    if (resource.real !== resource.lexical) {
      const realRule = denyRuleFor(resource.real, tier, viewer);
      if (realRule) {
        // The write tier has always resolved symlinks, so a link caught there is parity; a
        // link caught on the read or delete tier is bypass hardening.
        const basis = kind === 'fs_write' && realRule.since === 'legacy' ? 'ladder-parity' : 'bypass-hardening';
        return deny(
          basis,
          realRule.id,
          `${globalDenyReason(kind, tier, resource.raw, realRule.id)} (it resolves to ${resource.real})`,
        );
      }
    }
  }
  return null;
}

/** THE SHARE SURFACE: a path an agent may legitimately READ may still not be published
 *  to an unauthenticated URL or extracted into the model's context. */
export function shareDeny(resource: ResolvedPath, toolName: string): Verdict | null {
  for (const candidate of resource.lexical === resource.real ? [resource.lexical] : [resource.lexical, resource.real]) {
    if (!isSensitivePath(candidate)) continue;
    const viaLink = candidate !== resource.lexical;
    return deny(
      viaLink ? 'bypass-hardening' : 'ladder-parity',
      'sensitive-share',
      'sensitive path block list',
      `[BLOCKED] ${toolName} refused: ${resource.lexical} is on the sensitive-files block list ` +
        `(secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never publishes ` +
        `secret files or reads them into the conversation. If you need a value from this file, ` +
        `ask the person you are talking to, those values live in process memory only.`,
    );
  }
  return null;
}

/** `authorize(grant, {kind: fs_*, resource})`. `surface: 'share'` additionally asks the
 *  sensitive tier, what the share/pdf call sites do on top of the read permission. */
export function authorizeFs(
  grant: Grant,
  kind: FsKind,
  resource: ResolvedPath,
  surface: 'tool' | 'share' = 'tool',
  toolName = 'this tool',
): Verdict {
  if (surface === 'share') {
    const shared = shareDeny(resource, toolName);
    if (shared) return shared;
  }

  // A scoped row binds every agent except the one it names, so the viewer is derived from the grant's agent.
  const globallyDenied = globalDeny(kind, resource, () => (ownsTheMac(grant.agentId) ? 'main' : isHealerAgent(grant.agentId) ? 'healer' : 'other'));
  if (globallyDenied) return globallyDenied;

  // The trainer's broad file_write never re-opens the owner's identity/profile or
  // platform config: this runs ahead of the allow AND the squad fallback.
  if (kind === 'fs_write' && isTrainerAgent(grant.agentId) && isProtectedIdentityPath(resource.raw)) {
    return deny(
      'ladder-parity',
      'trainer-identity-write',
      `Global deny: writing to ${resource.raw} is not permitted (owner identity/config files are protected from the technique trainer)`,
    );
  }

  const verdict = evaluateRules(grant, GRANT_KIND[kind], (pattern) => matchPathPattern(pattern, resource.lexical));
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  if (verdict.decided && !verdict.allowed) {
    return deny('ladder-parity', verdict.pattern, `${kind} denied by agent policy for path: ${resource.raw}`);
  }

  // The squad-workspace fallback: an agent in a squad gets read+write inside that
  // technique's directory; stage 1 already ran, so no globally denied path re-opens here.
  if (kind !== 'fs_delete' && hasSquadWorkspaceAccess(grant.agentId, resource.raw)) {
    return allow('squad-workspace');
  }

  if (kind === 'fs_delete') {
    return deny(
      'ladder-parity',
      'no-delete-grant',
      grant.manifest.file_delete === 'none'
        ? 'File deletion is not permitted for this agent'
        : `File deletion not allowed for path: ${resource.raw}`,
    );
  }
  const accessList = kind === 'fs_read' ? grant.manifest.file_read : grant.manifest.file_write;
  const configured = accessList === '*' || Array.isArray(accessList);
  const legacyKind = kind === 'fs_read' ? 'file_read' : 'file_write';
  return deny(
    'ladder-parity',
    'no-grant',
    configured
      ? `${legacyKind} not allowed for path: ${resource.raw}`
      : `${legacyKind} not configured for this agent`,
  );
}
