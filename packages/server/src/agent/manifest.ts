// The stored grant, read here. Lives apart from `permissions.ts` (which re-exports these and
// now reads the brokers) so `brokers/grants.ts` can project `grant_rule` rows without a cycle.

import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
import type { PermissionManifest } from '@dojo/shared';
import { DEFAULT_SUBAGENT_PERMISSIONS } from '@dojo/shared';
import { homeDir } from '../home.js';

const logger = createLogger('permissions');

export const PRIMARY_AGENT_PERMISSIONS: PermissionManifest = {
  file_read: '*',
  file_write: '*',
  exec_allow: ['*'],
  exec_deny: [],
  shell_allow: ['*'],
  shell_deny: [],
  network_domains: '*',
  can_spawn_agents: true,
  can_assign_permissions: true,
  // AppleScript is not a category, so `'*'` misses it: named here to keep this agent's reach.
  system_control: ['*', 'applescript'],
};

// The artifact dir holds the agent's id, so it is added per agent on every branch, widening only:
// `'*'` stays a wildcard (expanding it would narrow it) and `'none'` stays deny-all, never spread
// into a list of four one-letter allow patterns. `scope.ts`'s `pathSubset` guards it the same way.

/** `~/.dojo/uploads/<agentId>/**`: this agent's own artifact directory. */
export function artifactPathFor(agentId: string): string {
  return path.join(homeDir(), '.dojo', 'uploads', agentId, '**');
}

// `X/**` misses the dir node (`file_list` needs it): granted on `file_read` only; matcher stays strict.
function withArtifactPath(value: string[] | '*' | 'none', agentId: string, alsoTheDirectory = false): string[] | '*' | 'none' {
  if (value === '*') return '*';
  if (value === 'none') return 'none';   // deny-all has nothing to widen
  const artifact = artifactPathFor(agentId);
  const missing = (alsoTheDirectory ? [artifact, artifactDirFor(agentId)] : [artifact]).filter((p) => !value.includes(p));
  return missing.length === 0 ? value : [...value, ...missing];
}

export function artifactDirFor(agentId: string): string {
  return path.join(homeDir(), '.dojo', 'uploads', agentId);
}

export function withArtifactPaths(manifest: PermissionManifest, agentId: string): PermissionManifest {
  return {
    ...manifest,
    file_read: withArtifactPath(manifest.file_read, agentId, true),
    file_write: withArtifactPath(manifest.file_write, agentId),
  };
}

export function getAgentPermissions(agentId: string): PermissionManifest {
  if (isPrimaryAgent(agentId)) {
    return PRIMARY_AGENT_PERMISSIONS;
  }

  const db = getDb();
  const agent = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(agentId) as { permissions: string | null } | undefined;

  if (!agent) {
    logger.warn('Agent not found for permissions check, using restricted defaults', { agentId }, agentId);
    return withArtifactPaths(DEFAULT_SUBAGENT_PERMISSIONS, agentId);
  }

  if (agent.permissions && agent.permissions !== '{}') {
    try {
      const parsed = JSON.parse(agent.permissions) as Partial<PermissionManifest>;
      // Stored manifests predate the artifact dir; it is filled in on read, no row is ever edited.
      return withArtifactPaths({
        file_read: parsed.file_read ?? DEFAULT_SUBAGENT_PERMISSIONS.file_read,
        file_write: parsed.file_write ?? DEFAULT_SUBAGENT_PERMISSIONS.file_write,
        exec_allow: parsed.exec_allow ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_allow,
        exec_deny: parsed.exec_deny ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_deny,
        // Absent, the shell follows `exec_allow` (every reader falls back to it); an explicit `[]` means "no shell".
        shell_allow: parsed.shell_allow,
        shell_deny: parsed.shell_deny,
        network_domains: parsed.network_domains ?? DEFAULT_SUBAGENT_PERMISSIONS.network_domains,
        can_spawn_agents: parsed.can_spawn_agents ?? DEFAULT_SUBAGENT_PERMISSIONS.can_spawn_agents,
        can_assign_permissions: parsed.can_assign_permissions ?? DEFAULT_SUBAGENT_PERMISSIONS.can_assign_permissions,
        system_control: parsed.system_control ?? DEFAULT_SUBAGENT_PERMISSIONS.system_control,
      }, agentId);
    } catch {
      logger.warn('Failed to parse agent permissions, using defaults', { agentId }, agentId);
    }
  }

  return withArtifactPaths(DEFAULT_SUBAGENT_PERMISSIONS, agentId);
}
