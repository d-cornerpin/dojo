// The stored grant, read here. Lives apart from `permissions.ts` (which re-exports these and
// now reads the brokers) so `brokers/grants.ts` can project `grant_rule` rows without a cycle.

import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
import type { PermissionManifest } from '@dojo/shared';
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
  max_processes: 10,
  can_spawn_agents: true,
  can_assign_permissions: true,
  // AppleScript is not a category, so `'*'` misses it: named here to keep this agent's reach.
  system_control: ['*', 'applescript'],
};

/** A helper's default commands: one list, so the exec and shell doors stay equal. */
const HELPER_COMMANDS = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'node', 'npm', 'npx', 'git', 'mv', 'cp', 'sort', 'jq', 'tee'];
export const DEFAULT_SUBAGENT_PERMISSIONS: PermissionManifest = {
  file_read: ['~/Projects/**', '/tmp/**'],
  file_write: ['~/Projects/**', '/tmp/**'],
  // `mv`/`cp` so a delegated worker can place an artifact it produced.
  exec_allow: HELPER_COMMANDS,
  exec_deny: ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'],
  shell_allow: HELPER_COMMANDS,
  shell_deny: ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'],
  // Wide by design (workers browse): the default inherits the parent minus danger; network is not danger.
  network_domains: '*',
  max_processes: 3,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
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
  const agent = db.prepare('SELECT permissions, spawn_depth, created_by FROM agents WHERE id = ?').get(agentId) as {
    permissions: string | null;
    spawn_depth: number | null;
    created_by: string | null;
  } | undefined;

  if (!agent) {
    logger.warn('Agent not found for permissions check, using restricted defaults', { agentId }, agentId);
    return withArtifactPaths(DEFAULT_SUBAGENT_PERMISSIONS, agentId);
  }

  // The seeded primary (`created_by='system'`, depth 0) keeps full permissions while the
  // `primary_agent_id` key is momentarily unset; depth alone is not trust (created agents are 0 too).
  if (agent.spawn_depth === 0 && agent.created_by === 'system') {
    return PRIMARY_AGENT_PERMISSIONS;
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
        // Stored manifests predate the shell class: falling back to the row's own `exec_allow` keeps
        // its reach. `?? undefined` is deliberate: an explicit `[]` survives and means "no shell".
        shell_allow: parsed.shell_allow ?? parsed.exec_allow ?? DEFAULT_SUBAGENT_PERMISSIONS.shell_allow,
        shell_deny: parsed.shell_deny ?? parsed.exec_deny ?? DEFAULT_SUBAGENT_PERMISSIONS.shell_deny,
        network_domains: parsed.network_domains ?? DEFAULT_SUBAGENT_PERMISSIONS.network_domains,
        max_processes: parsed.max_processes ?? DEFAULT_SUBAGENT_PERMISSIONS.max_processes,
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
