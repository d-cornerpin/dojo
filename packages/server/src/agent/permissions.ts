import os from 'node:os';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
import type { PermissionManifest } from '@dojo/shared';

const logger = createLogger('permissions');

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

// ── Default Permissions ──

export const PRIMARY_AGENT_PERMISSIONS: PermissionManifest = {
  file_read: '*',
  file_write: '*',
  file_delete: 'none',
  exec_allow: ['*'],
  exec_deny: [],
  network_domains: '*',
  max_processes: 10,
  can_spawn_agents: true,
  can_assign_permissions: true,
  system_control: ['*'],
};

export const DEFAULT_SUBAGENT_PERMISSIONS: PermissionManifest = {
  file_read: ['~/Projects/**', '/tmp/**'],
  file_write: ['~/Projects/**', '/tmp/**'],
  file_delete: 'none',
  exec_allow: ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'node', 'npm', 'npx', 'git'],
  exec_deny: ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'],
  network_domains: 'none',
  max_processes: 3,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
};

// ── Global Deny Rules (hardcoded, unoverridable) ──

const GLOBAL_FILE_WRITE_DENY = [
  '~/.dojo/secrets.yaml',
  '~/.dojo/data/*.db',
  '**/SOUL.md',
  '**/PM-SOUL.md',
];

const GLOBAL_FILE_DELETE_DENY = [
  '~/.dojo/**',
];

const GLOBAL_EXEC_DENY = [
  'rm -rf /',
  'rm -rf ~',
  'sudo *',
  'chmod 777 *',
];

// ── Glob Matching ──

function expandTilde(pattern: string): string {
  const home = os.homedir();
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return home + pattern.slice(1);
  return pattern;
}

/**
 * Simple glob matcher supporting:
 * - * matches any characters within a single path segment (no /)
 * - ** matches any number of path segments (including zero)
 * - ? matches a single character
 */
export function matchGlob(pattern: string, value: string): boolean {
  const expandedPattern = expandTilde(pattern);
  const expandedValue = expandTilde(value);

  // Convert glob to regex
  let regex = '';
  let i = 0;
  while (i < expandedPattern.length) {
    const ch = expandedPattern[i];

    if (ch === '*') {
      if (i + 1 < expandedPattern.length && expandedPattern[i + 1] === '*') {
        // ** — match anything including /
        i += 2;
        if (i < expandedPattern.length && expandedPattern[i] === '/') {
          // **/ — match zero or more path segments
          regex += '(?:.*/)?';
          i++;
        } else {
          // ** at end — match everything
          regex += '.*';
        }
      } else {
        // * — match anything except /
        regex += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '.') {
      regex += '\\.';
      i++;
    } else if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '+' || ch === '^' || ch === '$' || ch === '|' || ch === '\\') {
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  try {
    return new RegExp('^' + regex + '$').test(expandedValue);
  } catch {
    // If regex compilation fails, fall back to exact match
    return expandedPattern === expandedValue;
  }
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some(pattern => matchGlob(pattern, value));
}

// ── Permission Retrieval ──

export function getAgentPermissions(agentId: string): PermissionManifest {
  // Primary agent always gets full permissions
  if (isPrimaryAgent(agentId)) {
    return PRIMARY_AGENT_PERMISSIONS;
  }

  const db = getDb();
  const agent = db.prepare('SELECT permissions, spawn_depth FROM agents WHERE id = ?').get(agentId) as {
    permissions: string | null;
    spawn_depth: number | null;
  } | undefined;

  if (!agent) {
    logger.warn('Agent not found for permissions check, using restricted defaults', { agentId }, agentId);
    return DEFAULT_SUBAGENT_PERMISSIONS;
  }

  // spawn_depth 0 agents (primary-level) get full permissions
  if (agent.spawn_depth === 0) {
    return PRIMARY_AGENT_PERMISSIONS;
  }

  // Try to parse stored permissions
  if (agent.permissions && agent.permissions !== '{}') {
    try {
      const parsed = JSON.parse(agent.permissions) as Partial<PermissionManifest>;
      // Merge with defaults for any missing fields
      return {
        file_read: parsed.file_read ?? DEFAULT_SUBAGENT_PERMISSIONS.file_read,
        file_write: parsed.file_write ?? DEFAULT_SUBAGENT_PERMISSIONS.file_write,
        file_delete: parsed.file_delete ?? DEFAULT_SUBAGENT_PERMISSIONS.file_delete,
        exec_allow: parsed.exec_allow ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_allow,
        exec_deny: parsed.exec_deny ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_deny,
        network_domains: parsed.network_domains ?? DEFAULT_SUBAGENT_PERMISSIONS.network_domains,
        max_processes: parsed.max_processes ?? DEFAULT_SUBAGENT_PERMISSIONS.max_processes,
        can_spawn_agents: parsed.can_spawn_agents ?? DEFAULT_SUBAGENT_PERMISSIONS.can_spawn_agents,
        can_assign_permissions: parsed.can_assign_permissions ?? DEFAULT_SUBAGENT_PERMISSIONS.can_assign_permissions,
        system_control: parsed.system_control ?? DEFAULT_SUBAGENT_PERMISSIONS.system_control,
      };
    } catch {
      logger.warn('Failed to parse agent permissions, using defaults', { agentId }, agentId);
    }
  }

  return DEFAULT_SUBAGENT_PERMISSIONS;
}

// ── Permission Checking ──

function checkGlobalDenyFileWrite(filePath: string): PermissionResult {
  const expanded = expandTilde(filePath);
  for (const pattern of GLOBAL_FILE_WRITE_DENY) {
    if (matchGlob(pattern, expanded)) {
      return { allowed: false, reason: `Global deny: writing to ${filePath} is prohibited` };
    }
  }
  return { allowed: true };
}

function checkGlobalDenyFileDelete(filePath: string): PermissionResult {
  const expanded = expandTilde(filePath);
  for (const pattern of GLOBAL_FILE_DELETE_DENY) {
    if (matchGlob(pattern, expanded)) {
      return { allowed: false, reason: `Global deny: deleting ${filePath} is prohibited` };
    }
  }
  return { allowed: true };
}

function checkGlobalDenyExec(command: string): PermissionResult {
  for (const pattern of GLOBAL_EXEC_DENY) {
    if (matchGlob(pattern, command)) {
      return { allowed: false, reason: `Global deny: command "${command}" is prohibited` };
    }
  }
  // Also check if command starts with a denied prefix
  const trimmed = command.trim();
  for (const pattern of GLOBAL_EXEC_DENY) {
    const expandedPattern = expandTilde(pattern);
    // Handle patterns like "sudo *" by checking prefix
    if (expandedPattern.endsWith(' *')) {
      const prefix = expandedPattern.slice(0, -2);
      if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
        return { allowed: false, reason: `Global deny: command starting with "${prefix}" is prohibited` };
      }
    }
  }
  return { allowed: true };
}

function checkFileAccess(manifest: PermissionManifest, filePath: string, accessType: 'file_read' | 'file_write' | 'file_delete'): PermissionResult {
  const expanded = expandTilde(filePath);

  if (accessType === 'file_delete') {
    // Check global deny first
    const globalCheck = checkGlobalDenyFileDelete(expanded);
    if (!globalCheck.allowed) return globalCheck;

    // file_delete is either 'none' or string[]
    if (manifest.file_delete === 'none') {
      return { allowed: false, reason: 'File deletion is not permitted for this agent' };
    }
    // file_delete as string[] — check patterns
    if (Array.isArray(manifest.file_delete)) {
      if (matchesAny(manifest.file_delete, expanded)) {
        return { allowed: true };
      }
      return { allowed: false, reason: `File deletion not allowed for path: ${filePath}` };
    }
    return { allowed: false, reason: 'File deletion is not permitted for this agent' };
  }

  // file_read or file_write
  if (accessType === 'file_write') {
    // Check global deny first
    const globalCheck = checkGlobalDenyFileWrite(expanded);
    if (!globalCheck.allowed) return globalCheck;
  }

  const accessList = accessType === 'file_read' ? manifest.file_read : manifest.file_write;

  if (accessList === '*') {
    return { allowed: true };
  }

  if (Array.isArray(accessList)) {
    if (matchesAny(accessList, expanded)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `${accessType} not allowed for path: ${filePath}` };
  }

  return { allowed: false, reason: `${accessType} not configured for this agent` };
}

function checkExecPermission(manifest: PermissionManifest, command: string): PermissionResult {
  // Global deny always checked first
  const globalCheck = checkGlobalDenyExec(command);
  if (!globalCheck.allowed) return globalCheck;

  const trimmed = command.trim();

  // Check manifest exec_deny
  for (const pattern of manifest.exec_deny) {
    if (matchGlob(pattern, trimmed)) {
      return { allowed: false, reason: `Command denied by agent policy: "${command}"` };
    }
    // Handle prefix patterns like "sudo *"
    const expandedPattern = expandTilde(pattern);
    if (expandedPattern.endsWith(' *')) {
      const prefix = expandedPattern.slice(0, -2);
      if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
        return { allowed: false, reason: `Command denied by agent policy: starts with "${prefix}"` };
      }
    }
  }

  // Check manifest exec_allow
  if (manifest.exec_allow.includes('*')) {
    return { allowed: true };
  }

  // Extract the base command (first word)
  const baseCommand = trimmed.split(/\s+/)[0];

  for (const allowed of manifest.exec_allow) {
    if (matchGlob(allowed, trimmed) || matchGlob(allowed, baseCommand)) {
      return { allowed: true };
    }
  }

  const allowedList = manifest.exec_allow.join(', ');
  return { allowed: false, reason: `Command "${baseCommand}" is not allowed. Your permitted commands are: ${allowedList}` };
}

function checkSpawnPermission(manifest: PermissionManifest): PermissionResult {
  if (manifest.can_spawn_agents) {
    return { allowed: true };
  }
  return { allowed: false, reason: 'Agent spawning is not permitted' };
}

function checkNetworkPermission(manifest: PermissionManifest, domain: string): PermissionResult {
  if (manifest.network_domains === '*') {
    return { allowed: true };
  }
  if (manifest.network_domains === 'none') {
    return { allowed: false, reason: 'Network access is not permitted for this agent' };
  }
  if (Array.isArray(manifest.network_domains)) {
    if (manifest.network_domains.some(d => domain === d || domain.endsWith('.' + d))) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Network access not allowed for domain: ${domain}` };
  }
  return { allowed: false, reason: 'Network access not configured' };
}

// ── Squad Workspace Access ──

/**
 * Check if an agent has squad workspace access to a draft/review technique directory.
 * When an agent belongs to a group (squad) that is building a technique, the agent
 * is automatically granted file_read and file_write access to that technique's directory.
 */
function hasSquadWorkspaceAccess(agentId: string, filePath: string): boolean {
  const db = getDb();
  const agent = db.prepare('SELECT group_id FROM agents WHERE id = ?').get(agentId) as { group_id: string | null } | undefined;
  if (!agent?.group_id) return false;

  const technique = db.prepare(`
    SELECT directory_path FROM techniques
    WHERE build_squad_id = ? AND state IN ('draft', 'review')
  `).get(agent.group_id) as { directory_path: string } | undefined;

  if (!technique) return false;

  // Check if the file path is within the technique's directory
  const expandedPath = expandTilde(filePath);
  const expandedDir = expandTilde(technique.directory_path);
  return expandedPath.startsWith(expandedDir);
}

// ── Main Entry Point ──

export function checkPermission(agentId: string, action: PermissionAction): PermissionResult {
  const manifest = getAgentPermissions(agentId);

  let result: PermissionResult;

  switch (action.type) {
    case 'file_read':
      if (!action.path) {
        result = { allowed: false, reason: 'No path specified for file_read' };
      } else {
        result = checkFileAccess(manifest, action.path, 'file_read');
        // Fall back to squad workspace access if normal permissions denied
        if (!result.allowed && hasSquadWorkspaceAccess(agentId, action.path)) {
          result = { allowed: true };
        }
      }
      break;

    case 'file_write':
      if (!action.path) {
        result = { allowed: false, reason: 'No path specified for file_write' };
      } else {
        result = checkFileAccess(manifest, action.path, 'file_write');
        // Fall back to squad workspace access if normal permissions denied
        if (!result.allowed && hasSquadWorkspaceAccess(agentId, action.path)) {
          // Still enforce global deny rules for file_write
          const globalCheck = checkGlobalDenyFileWrite(expandTilde(action.path));
          result = globalCheck.allowed ? { allowed: true } : globalCheck;
        }
      }
      break;

    case 'file_delete':
      if (!action.path) {
        result = { allowed: false, reason: 'No path specified for file_delete' };
      } else {
        result = checkFileAccess(manifest, action.path, 'file_delete');
      }
      break;

    case 'exec':
      if (!action.command) {
        result = { allowed: false, reason: 'No command specified for exec' };
      } else {
        result = checkExecPermission(manifest, action.command);
      }
      break;

    case 'spawn':
      result = checkSpawnPermission(manifest);
      break;

    case 'network':
      if (!action.domain) {
        result = { allowed: false, reason: 'No domain specified for network' };
      } else {
        result = checkNetworkPermission(manifest, action.domain);
      }
      break;

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
