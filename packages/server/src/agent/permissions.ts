// The legacy adapter its nine remaining callers still speak to, answering from the
// brokers. destructive-gate.ts records this call as the EXACT one executeTool
// makes, so its shape stays; spawner.ts keeps its own separate spawn gate.

import { createLogger } from '../logger.js';
import { getAgentPermissions } from './manifest.js';
import { grantForManifest } from './brokers/grants.js';
import { authorizeFs } from './brokers/fs.js';
import { authorizeProc } from './brokers/proc.js';
import { authorizeNetDomain } from './brokers/net.js';
import { authorizeSpawn } from './brokers/index.js';
import { resolvePathArg, resolveCommandArg } from './brokers/resolve.js';

const logger = createLogger('permissions');

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


export interface PermissionAction {
  type: 'file_read' | 'file_write' | 'exec' | 'spawn' | 'network';
  path?: string;
  command?: string;
  domain?: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}


/** A MISSING argument is a REFUSAL here: callers depend on this legacy shape. The
 *  ladder never asked in that case: two different questions, each keeps its answer. */
export function checkPermission(agentId: string, action: PermissionAction): PermissionResult {
  const grant = grantForManifest(agentId, getAgentPermissions(agentId));

  let result: PermissionResult;

  switch (action.type) {
    case 'file_read':
    case 'file_write': {
      const kind = action.type === 'file_read' ? 'fs_read' : 'fs_write';
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
      // `scanSensitiveReads` stays OFF here: this is the exact call destructive-gate records;
      // the tokenized scan belongs to the dispatcher, which asks with the scan ON.
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
