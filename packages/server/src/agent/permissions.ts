// ════════════════════════════════════════════════════════════════════════════
// `checkPermission` — NOW A READER OF THE BROKERS (PHASE-5 T2 Step 2).
//
// This module used to hold 687 lines: four deny lists, a glob engine, a symlink
// canonicalizer, a manifest reader, a squad fallback, and six `check*` functions
// with a hand-written order of operations. T2 did not add a second copy of any
// of it — it MOVED each piece to the place that owns it and left this file as
// the adapter its nine remaining callers still speak to:
//
//   the deny lists ....... `agent/brokers/deny.ts`      (all four, merged, ONE table)
//   the glob engine ...... `agent/path-resolve.ts`      (leaf)
//   the canonicalizer .... `agent/path-resolve.ts`      (leaf)
//   the manifest ......... `agent/manifest.ts`          (leaf)
//   the squad fallback ... `agent/squad-workspace.ts`   (leaf)
//   the decisions ........ `agent/brokers/{fs,proc,net}.ts` + `grants.ts`
//
// EVERY NAME THIS MODULE EXPORTED IS STILL EXPORTED FROM HERE, so not one of the
// nine callers moved: `destructive-gate.ts:126` (the EXACT call the approval
// seam records — RULING P5-R3 makes that coupling T3's to move, and this task
// must not disturb its shape), `spawner.ts:150` (the OTHER spawn gate — RULING
// P5-R2 leaves it STANDING and T5 owns the reconciliation), `path-guards.ts`'s
// share gate, `web-tools.ts` ×3, and the tests.
//
// THE ANSWERS ARE UNCHANGED. That is not an aspiration, it is the acceptance
// criterion: `permissions-log-deny`, `share-guards`, `exec-shell-grammar` and
// `net-guard` all assert against this function and none of them was touched.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getAgentPermissions } from './manifest.js';
import { grantForManifest } from './brokers/grants.js';
import { authorizeFs } from './brokers/fs.js';
import { authorizeProc } from './brokers/proc.js';
import { authorizeNetDomain } from './brokers/net.js';
import { authorizeSpawn } from './brokers/index.js';
import { resolvePathArg, resolveCommandArg } from './brokers/resolve.js';

const logger = createLogger('permissions');

// ── Re-exports: this module's published surface, unchanged ──
export { getAgentPermissions, PRIMARY_AGENT_PERMISSIONS, DEFAULT_SUBAGENT_PERMISSIONS } from './manifest.js';
export {
  resolveRealPathHardened,
  isProtectedIdentityPath,
  canonicalizeAgentPath,
  matchAgentGlob,
  matchAgentGlob as matchGlob,
  matchAgentPathGlob,
} from './path-resolve.js';
export { hasSquadWorkspaceAccess } from './squad-workspace.js';

// ── Types ──

export interface PermissionAction {
  type: 'file_read' | 'file_write' | 'file_delete' | 'exec' | 'spawn' | 'network';
  path?: string;
  command?: string;
  domain?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ── Main Entry Point ──

/**
 * THE LEGACY SHAPE, answered by the brokers.
 *
 * One behaviour is worth naming because it is the shape of the old code rather
 * than a decision: a MISSING argument is a refusal here (`No path specified for
 * file_read`), because that is what this function has always answered. The
 * LADDER never asked in that case — `if (filePath)` skipped it — so the
 * dispatcher preserves the skip and this adapter preserves the refusal. They are
 * two different questions and each keeps its own old answer.
 */
export function checkPermission(agentId: string, action: PermissionAction): PermissionResult {
  const grant = grantForManifest(agentId, getAgentPermissions(agentId));

  let result: PermissionResult;

  switch (action.type) {
    case 'file_read':
    case 'file_write':
    case 'file_delete': {
      const kind = action.type === 'file_read' ? 'fs_read' : action.type === 'file_write' ? 'fs_write' : 'fs_delete';
      const resolved = resolvePathArg(action.path);
      if (!resolved.ok) {
        result = { allowed: false, reason: `No path specified for ${action.type}` };
        break;
      }
      const verdict = authorizeFs(grant, kind, resolved.value);
      result = verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
      break;
    }

    case 'exec': {
      const resolved = resolveCommandArg(action.command);
      if (!resolved.ok) {
        result = { allowed: false, reason: 'No command specified for exec' };
        break;
      }
      // `scanSensitiveReads` stays OFF here: this is the shape `destructive-gate`
      // records as *"the EXACT call executeTool makes"*, and the tokenized scan
      // was never part of it — it lived in the exec HANDLER. The dispatcher asks
      // with the scan ON, at the point the handler used to.
      const verdict = authorizeProc(grant, resolved.value, false);
      result = verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
      break;
    }

    case 'spawn': {
      const verdict = authorizeSpawn(grant);
      result = verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
      break;
    }

    case 'network': {
      if (!action.domain) {
        result = { allowed: false, reason: 'No domain specified for network' };
        break;
      }
      const verdict = authorizeNetDomain(grant, action.domain);
      result = verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason };
      break;
    }

    default:
      result = { allowed: false, reason: `Unknown action type: ${(action as PermissionAction).type}` };
  }

  if (!result.allowed) {
    logger.warn('Permission denied', {
      agentId,
      action: action.type,
      path: action.path,
      command: action.command,
      domain: action.domain,
      reason: result.reason,
    }, agentId);
  }

  return result;
}
