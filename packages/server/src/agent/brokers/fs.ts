// ════════════════════════════════════════════════════════════════════════════
// THE FILESYSTEM BROKER (PHASE-5 T2 Step 2).
//
// One door for "may this agent touch this path?", asked of a RESOLVED path so
// the answer cannot be about a different file from the one that opens.
//
// The order below is `permissions.ts:checkFileAccess` + `checkPermission`'s
// file branches, reproduced deliberately rather than re-invented — RULING P5-R5
// is enforcement parity, and the way to keep parity is to keep the order:
//
//   1. the merged GLOBAL deny list      (unoverridable; no manifest re-opens it)
//   2. the trainer identity write-deny  (FU-4, ahead of the allow AND the squad
//                                        fallback, because either would re-open it)
//   3. the agent's own grant rows       (deny before allow, `ORDER BY mode DESC`)
//   4. the squad-workspace fallback     (with the global deny re-applied — the
//                                        FA-P5 defect, now structural: stage 1
//                                        runs before this and stage 4 re-asks)
//
// WHAT CHANGED, and it is exactly one thing: stage 1 is asked about the
// SYMLINK-RESOLVED target as well as the lexical one on every kind. The write
// tier already did that (N3); the read tier never did, so a link planted in an
// allowed directory read `secrets.yaml` in the clear. Those refusals carry
// `basis: 'bypass-hardening'` and Step 4 stages them.
// ════════════════════════════════════════════════════════════════════════════

import { isTrainerAgent } from '../../config/platform.js';
import { isProtectedIdentityPath } from '../path-resolve.js';
import { hasSquadWorkspaceAccess } from '../squad-workspace.js';
import { denyRuleFor, tiersForKind, isSensitivePath, type DenyTier } from './deny.js';
import { evaluateRules, matchPathPattern, type Grant, type GrantEffectKind } from './grants.js';
import type { ResolvedPath } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

export type FsKind = 'fs_read' | 'fs_write' | 'fs_delete';

/** The legacy per-kind refusal wording, kept verbatim so agent-facing strings
 *  do not move under a refactor (#15's sibling: a message an agent parses is a
 *  contract). */
function globalDenyReason(kind: FsKind, tier: DenyTier, rawPath: string): string {
  if (tier === 'sensitive') {
    return `${rawPath} is on the sensitive-files block list (secrets.yaml, .env files, SSH keys, cloud credentials)`;
  }
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

/**
 * Stage 1, isolated so both the tool surface and the SHARE surface ask the same
 * question. Returns null when nothing denies.
 *
 * BOTH spellings are asked. When only the symlink-resolved target is denied the
 * verdict is `bypass-hardening`; when the lexical path is denied it is
 * `ladder-parity`, because that is the refusal the tree already produced.
 */
export function globalDeny(kind: FsKind, resource: ResolvedPath): Verdict | null {
  for (const tier of tiersForKind(kind)) {
    const lexicalRule = denyRuleFor(resource.lexical, tier);
    if (lexicalRule) {
      const basis = lexicalRule.since === 'legacy' ? 'ladder-parity' : 'bypass-hardening';
      return deny(basis, lexicalRule.id, globalDenyReason(kind, tier, resource.raw));
    }
    if (resource.real !== resource.lexical) {
      const realRule = denyRuleFor(resource.real, tier);
      if (realRule) {
        // The WRITE tier already resolved symlinks before T2, so a link caught
        // on that tier is parity; the read/delete tiers did not, so a link
        // caught there is this task's hardening.
        const basis = kind === 'fs_write' && realRule.since === 'legacy' ? 'ladder-parity' : 'bypass-hardening';
        return deny(
          basis,
          realRule.id,
          `${globalDenyReason(kind, tier, resource.raw)} (it resolves to ${resource.real})`,
        );
      }
    }
  }
  return null;
}

/**
 * THE SHARE SURFACE. `share_file` / `share_publicly` / every pdf input path ask
 * this: a path an agent may legitimately READ may still not be published to an
 * unauthenticated URL or extracted into the model's context. It is
 * `path-guards.ts:sharePathGuard`'s first half, now asking the merged list.
 */
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
        `ask the user, those values live in process memory only.`,
    );
  }
  return null;
}

/**
 * `authorize(grant, {kind: fs_*, resource})`.
 *
 * `surface: 'share'` additionally asks the sensitive tier, which is what the
 * share/pdf call sites have always done on top of the read permission.
 */
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

  const globallyDenied = globalDeny(kind, resource);
  if (globallyDenied) return globallyDenied;

  // FU-4: the technique trainer holds broad file_write ('*') for technique work,
  // but the owner's identity/profile and platform config stay protected. Ahead
  // of the allow AND the squad fallback, so neither can re-open it.
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

  // The squad-workspace fallback: an agent in a squad building a technique gets
  // read+write inside that technique's directory. Stage 1 already ran, so a
  // globally-denied path cannot be re-opened here — the FA-P5 defect is now the
  // shape of the function rather than a comment asking the reader to remember.
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
