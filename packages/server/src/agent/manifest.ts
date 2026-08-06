// ════════════════════════════════════════════════════════════════════════════
// THE PERMISSION MANIFEST — the stored grant, and how it is read (PHASE-5 T2).
//
// Extracted verbatim from `agent/permissions.ts` so `brokers/grants.ts` can
// project a manifest into `grant_rule` rows without importing the module that
// now READS the brokers. `permissions.ts` re-exports all three names.
//
// T5 owns validating this shape (zod), enforcing child ⊆ parent, and migrating
// `agents.permissions` into the validated form. Until then this is the source of
// truth for a grant and the rows are its projection.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent } from '../config/platform.js';
import type { PermissionManifest } from '@dojo/shared';

const logger = createLogger('permissions');

export const PRIMARY_AGENT_PERMISSIONS: PermissionManifest = {
  file_read: '*',
  file_write: '*',
  file_delete: 'none',
  exec_allow: ['*'],
  exec_deny: [],
  // PHASE-5 T3: the primary's shell reach, stated rather than inherited. It is
  // what `exec_allow` already meant for this agent before exec had two doors.
  shell_allow: ['*'],
  shell_deny: [],
  network_domains: '*',
  max_processes: 10,
  can_spawn_agents: true,
  can_assign_permissions: true,
  // PHASE-5 T5: `'*'` and `'applescript'`, and the second name is not redundant.
  // `'*'` grants every system-control CATEGORY; AppleScript stopped being one of
  // them in `brokers/grants.ts` this task, because osascript is a second
  // interpreter rather than a category (the plan's own direction at T3 Step 2).
  // Naming it here is what makes that flip cost the owner's own agent nothing —
  // the explicit grant lands BEFORE the blanket stops covering it, which is the
  // only order that preserves capability. Migration 155 does the same for every
  // stored manifest that held `'*'`.
  system_control: ['*', 'applescript'],
};

export const DEFAULT_SUBAGENT_PERMISSIONS: PermissionManifest = {
  file_read: ['~/Projects/**', '/tmp/**'],
  file_write: ['~/Projects/**', '/tmp/**'],
  file_delete: 'none',
  // ⚠ 12 → 14 — OWNER RULING, 2026-08-05 (SWEEP-A TB8 JOB 3), in his own terms:
  // *agents do work, and doing work means moving files.* A default sub-agent could
  // read, search and count, and could run `node`/`npm`/`git`, but could not `mv` or
  // `cp` a file it had just produced — so a delegated worker could build an artifact
  // and not put it where it belonged. `mv` and `cp` join both doors.
  //
  // What this is NOT: a relaxation of anything. The twelve commands above are all
  // still here, `exec_deny`/`shell_deny` below are untouched, and `file_delete`
  // stays `'none'` — a move is not a delete, and the deny list still refuses
  // `rm -rf /`, `rm -rf ~`, `sudo *` and `chmod 777 *`. The file-path walls are
  // unchanged too: a default sub-agent's `file_write` is still `~/Projects/**`,
  // `/tmp/**` and its own artifact directory, so `mv` can only land a file where
  // that agent could already have written one.
  //
  // The gap this closes is the DEFAULT's alone. `PRIMARY_AGENT_PERMISSIONS.exec_allow`
  // has been `['*']` since it was written (:25 above), so the product never blocked a
  // file-move for the owner's own agent — the recurring `smell:permission-denied`
  // finding in the behavioral battery is the TEST BOT's own narrower manifest, a
  // separate fixture that the kit owns. Held by `agent/__tests__/child-scope.test.ts`,
  // which counts both doors and names both commands.
  exec_allow: ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'node', 'npm', 'npx', 'git', 'mv', 'cp'],
  exec_deny: ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'],
  // PHASE-5 T3 — SAME LIST, AND THAT IS THE MEASUREMENT, NOT A CHOICE.
  //
  // The plan words the shell class as *"explicitly granted, never default"*.
  // Measured at this HEAD, a default sub-agent's `exec_allow` is this non-empty
  // list, and the pre-T3 exec check only ever looked at the BASE COMMAND of each
  // inner command — so a default sub-agent could already run `ls -la | wc -l`
  // and `for f in *; do cat $f; done` today. Setting `shell_allow: []` here
  // would therefore REMOVE a working capability from every sub-agent on every
  // box, which the phase's binding posture makes an OWNER decision and not a
  // worker's. T3 makes withholding EXPRESSIBLE and preserves the reach; T5 owns
  // the default-manifest decision (its DECIDED block already covers sub-agent
  // scope: inherit parent minus danger). Recorded as a hand-up, not silently.
  // SAME LIST STILL — including the 2026-08-05 `mv`/`cp` ruling above. The two doors
  // are asserted equal by the child-scope test, so widening one without the other
  // would fail rather than drift.
  shell_allow: ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'echo', 'node', 'npm', 'npx', 'git', 'mv', 'cp'],
  shell_deny: ['rm -rf /', 'rm -rf ~', 'sudo *', 'chmod 777 *'],
  // ⚠ WAS `'none'`, AND THE PLAN CALLS THAT A FALSE STATEMENT (T5 Step 1).
  // The owner's DECIDED default is "inherit parent minus danger", and network is
  // not in the danger set — workers must browse. `'none'` projected NO net allow
  // rows, so every agent whose stored manifest is `'{}'` (40 of 56 on the dev
  // body) was refused `web_fetch` / `web_search` while the platform's own
  // documentation described them as researchers. Widening a default is never a
  // capability loss, and this one is the owner's own words.
  //
  // NOTE for whoever reads this next: this constant does TWO jobs — it is the
  // scope of every agent storing `'{}'` AND the fallback for an agent id that is
  // not in the table at all. The second is a bug-shaped path (`logger.warn`
  // "Agent not found") and it now inherits the wider default with the first.
  // Recorded as a hand-up in `.superpowers/sdd/PHASE-5/task-T5-report.md` §7
  // rather than fixed here, because splitting it is a different job.
  network_domains: '*',
  max_processes: 3,
  can_spawn_agents: false,
  can_assign_permissions: false,
  system_control: [],
};


// ── THE ARTIFACT DIRECTORY (PHASE-5 T5) ──
// `~/.dojo/uploads/<agentId>` is where an agent's own artifacts land —
// `image_create` writes there, `imessage_send` stages attachments there, the PDF
// tools output there. It was in NO default manifest, which is the gap T2's
// log-only staging window was opened for in the first place ("enforcing a
// brand-new refusal against sub-agents today would break every artifact flow").
// It cannot be a constant because the path contains the agent's id, so it is
// filled in per agent here, on every branch that returns a manifest.
//
// Widening only, and only into the agent's OWN directory: `'*'` is left alone
// rather than expanded into a list (turning a wildcard into an enumeration would
// NARROW it), and no agent gains a path belonging to another.

/** `~/.dojo/uploads/<agentId>/**` — this agent's own artifact directory. */
export function artifactPathFor(agentId: string): string {
  return path.join(os.homedir(), '.dojo', 'uploads', agentId, '**');
}

function withArtifactPath(value: string[] | '*', agentId: string): string[] | '*' {
  if (value === '*') return '*';
  const artifact = artifactPathFor(agentId);
  return value.includes(artifact) ? value : [...value, artifact];
}

/** Any manifest, with this agent's artifact directory readable and writable. */
export function withArtifactPaths(manifest: PermissionManifest, agentId: string): PermissionManifest {
  return {
    ...manifest,
    file_read: withArtifactPath(manifest.file_read, agentId),
    file_write: withArtifactPath(manifest.file_write, agentId),
  };
}

export function getAgentPermissions(agentId: string): PermissionManifest {
  // Primary agent always gets full permissions
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

  // The platform-seeded primary agent (created_by='system', spawn_depth 0,
  // seeded without a manifest in index.ts) keeps full permissions even if the
  // primary_agent_id config key is momentarily unset, that is the requirement
  // the old `spawn_depth === 0` shortcut encoded. The shortcut itself was a
  // security hole: POST /api/agents also writes spawn_depth 0 (meaning
  // "top-level", not "trusted"), so EVERY dashboard/user-created agent was
  // silently auto-promoted to PRIMARY_AGENT_PERMISSIONS and its stored
  // manifest ignored (behavioral run bmr59ix4lsg: a restricted test agent
  // pip-installed packages and wrote outside its allowlist). Created agents
  // are now governed by their stored manifest below.
  if (agent.spawn_depth === 0 && agent.created_by === 'system') {
    return PRIMARY_AGENT_PERMISSIONS;
  }

  // Try to parse stored permissions
  if (agent.permissions && agent.permissions !== '{}') {
    try {
      const parsed = JSON.parse(agent.permissions) as Partial<PermissionManifest>;
      // Merge with defaults for any missing fields, then add this agent's own
      // artifact directory (T5) — a stored manifest predates that path existing
      // in any default, so filling it in here is what makes every agent able to
      // reach its own uploads dir without anybody editing a row.
      return withArtifactPaths({
        file_read: parsed.file_read ?? DEFAULT_SUBAGENT_PERMISSIONS.file_read,
        file_write: parsed.file_write ?? DEFAULT_SUBAGENT_PERMISSIONS.file_write,
        file_delete: parsed.file_delete ?? DEFAULT_SUBAGENT_PERMISSIONS.file_delete,
        exec_allow: parsed.exec_allow ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_allow,
        exec_deny: parsed.exec_deny ?? DEFAULT_SUBAGENT_PERMISSIONS.exec_deny,
        // ⚠ THE MIGRATION, AND IT IS THIS LINE (PHASE-5 T3).
        // Every stored manifest on every live box predates the shell class, so
        // `parsed.shell_allow` is undefined for all of them. Falling back to
        // `parsed.exec_allow` — the agent's OWN stored list, not the default —
        // is what makes splitting exec into two doors cost no agent any reach it
        // has today. `?? undefined` is deliberate: an EXPLICIT `[]` survives and
        // means "no shell", which is how the class is withheld.
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
