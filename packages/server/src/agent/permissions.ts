import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { isPrimaryAgent, isTrainerAgent } from '../config/platform.js';
import { PROTECTED_IDENTITY_PATHS } from './sensei-policy.js';
import { foldPath } from './path-guards.js';
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
  // All sensei souls (PM/TRAINER/HEALER/DREAMER/IMAGINER-SOUL.md), not just
  // the PM's: "never modify your own system prompt" is engine-enforced, and
  // the old glob pair left every non-PM sensei soul writable.
  '**/*-SOUL.md',
];

const GLOBAL_FILE_DELETE_DENY = [
  '~/.dojo/**',
];

// v2.3.19 (error-handling-spec Phase 3 — Dreamer-style log discipline).
// The Healer is allowed to ASK ABOUT its history, but not via raw file
// reads — those bypass the engine helpers that cap response size and
// could choke the Healer's prompt. Use healer_recent_actions /
// healer_action_detail instead.
//
// secrets.yaml is also denied globally. NOTE: the file is stored as
// PLAINTEXT on disk, protected only by 0600 file permissions (owner
// decision 2026-07-04: keep plaintext for now). It is NOT encrypted at
// rest, so this global read-deny is the actual protection, not a
// fallback; do not weaken it on the assumption a read would return
// ciphertext. Even the Healer, whose job is to dig into anything, should
// never need the contents: secrets are loaded into process memory at
// startup and exposed only as the runtime needs them.
const GLOBAL_FILE_READ_DENY = [
  '~/.dojo/logs/healer.log',
  '~/.dojo/logs/healer-report.log',
  '~/.dojo/logs/healer-archives/**',
  '~/.dojo/secrets.yaml',
];

const GLOBAL_EXEC_DENY = [
  'rm -rf /',
  'rm -rf ~',
  'sudo *',
  'chmod 777 *',
];

// v2.3.19 (Scenario 3 finding) — file_write permission denies are
// trivial to bypass via shell exec ("echo '...' >> ~/.dojo/secrets.yaml"
// went through cleanly). The substring approach below catches every
// path form: tilde, absolute, $HOME, relative — all match. Targeted at
// the API-key store specifically; we don't try to build a general
// exec-write firewall here.
const GLOBAL_EXEC_DENY_SUBSTRINGS = [
  'secrets.yaml',
];

// ── Glob Matching ──

function expandTilde(pattern: string): string {
  const home = os.homedir();
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return home + pattern.slice(1);
  return pattern;
}

// Canonicalize a FILE PATH (not a glob pattern) before any allow/deny match.
// expandTilde only handles '~'; it does NOT collapse '..'. Without normalizing,
// a traversal like '~/Projects/../.dojo/secrets.yaml' string-matches a
// '~/Projects/**' allowlist yet the executor's own path.join resolves it to the
// real protected target, so the check and the write disagree and the sandbox is
// escaped. path.resolve expands to an absolute, normalized path with every '..'
// collapsed, so the allowlist and every global-deny match the ACTUAL target.
function canonicalizePath(filePath: string): string {
  return path.resolve(expandTilde(filePath));
}

// N3: canonicalizePath (path.resolve) is LEXICAL, it does not follow symlinks. The
// Trainer now holds exec + file_write '*', so it could plant a symlink under an
// allowed dir that points INTO a protected file and defeat the lexical prefix
// match. Resolve the DEEPEST EXISTING ancestor's real path (fs.realpathSync
// follows symlinks; fs.existsSync also follows them, so the walk stops at the
// nearest node that truly resolves), then re-append the non-existent tail. A
// symlinked file resolves in full; a symlinked directory in the middle resolves
// and the remaining tail rides on the real target. Never throws: realpath errors
// return { resolved:false } so callers pick their own posture (fail-closed for the
// identity tier, best-effort-additive for the globals). Cheap enough for the
// file-write path (a few stat syscalls, no I/O on the common lexical-hit fast path).
function realResolveDeepest(lexicalAbs: string, depth = 0): { path: string; resolved: boolean } {
  // Link-loop guard: a chain of broken links re-enters this function per hop.
  if (depth > 8) return { path: lexicalAbs, resolved: false };
  let existing = lexicalAbs;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    // existsSync FOLLOWS symlinks, so a BROKEN link (target does not exist yet)
    // reads as non-existent and the walk would otherwise step past it, resolving
    // the link's own path instead of its target. A write through that link CREATES
    // the target, so a planted broken link pointing at a not-yet-existing file
    // under a protected dir would slip the prefix match, and the link itself can
    // live anywhere writable, so failing closed on the link's own path is not
    // enough. lstat (no follow) detects the link; follow its TARGET (relative
    // targets resolve against the link's dir) and continue resolving from there
    // with the remaining tail. readlink errors report unresolvable.
    try {
      if (fs.lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
        const target = path.resolve(path.dirname(existing), fs.readlinkSync(existing));
        return realResolveDeepest(path.join(target, ...tail), depth + 1);
      }
    } catch {
      return { path: lexicalAbs, resolved: false };
    }
    const parent = path.dirname(existing);
    if (parent === existing) return { path: lexicalAbs, resolved: true }; // nothing exists to resolve
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    const real = fs.realpathSync(existing);
    return { path: tail.length > 0 ? path.join(real, ...tail) : real, resolved: true };
  } catch {
    return { path: lexicalAbs, resolved: false };
  }
}

// Hardened canonicalizer for callers OUTSIDE this module (the Healer scratch-zone
// auto-approve gate): expandTilde + collapse '..' (canonicalizePath) THEN resolve
// symlinks / broken links (realResolveDeepest), the exact pipeline
// isProtectedIdentityPath uses. { resolved:false } means resolution failed and the
// caller MUST fail closed (treat the target as out-of-zone / protected).
export function resolveRealPathHardened(filePath: string): { path: string; resolved: boolean } {
  return realResolveDeepest(canonicalizePath(filePath));
}

// The protected-identity tier lives entirely under ~/.dojo; a candidate under that
// root whose symlinks cannot be resolved is treated as protected (fail-closed).
function isUnderProtectedRoot(lexicalAbs: string): boolean {
  const root = foldPath(canonicalizePath('~/.dojo'));
  const candidate = foldPath(lexicalAbs);
  return candidate === root || candidate.startsWith(root + path.sep);
}

// FU-4 + N3: is this write target one of the owner's identity/config files
// (PROTECTED_IDENTITY_PATHS)? Canonicalize FIRST (collapse '..') so a traversal
// such as '~/.dojo/techniques/../prompts/USER.md' resolves before the prefix
// match, then re-check through symlinks so a planted link into a protected path is
// caught (see realResolveDeepest). FAIL-CLOSED: if symlink resolution errors for a
// candidate under the protected root, treat it as protected. Consumed two ways: a
// hard write-deny for the Trainer (below) and a destructive-classify signal for the
// Healer (destructive-gate.ts).
export function isProtectedIdentityPath(filePath: string): boolean {
  const lexical = canonicalizePath(filePath);
  if (PROTECTED_IDENTITY_PATHS.some(pattern => matchPathGlob(pattern, lexical))) return true;
  const { path: real, resolved } = realResolveDeepest(lexical);
  if (!resolved) return isUnderProtectedRoot(lexical);
  return PROTECTED_IDENTITY_PATHS.some(pattern => matchPathGlob(pattern, real));
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

// PHASE-0 T10 (see agent/path-guards.ts): matchGlob's regex is case-SENSITIVE,
// so on APFS '~/.dojo/Secrets.yaml' slipped every deny pattern while opening the
// same bytes. Expand '~' on BOTH sides first — matchGlob would otherwise
// re-expand a folded pattern back into a mixed-case absolute — then fold. Paths
// only; checkGlobalDenyExec still matches command shapes case-sensitively.
function matchPathGlob(pattern: string, value: string): boolean {
  return matchGlob(foldPath(expandTilde(pattern)), foldPath(expandTilde(value)));
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some(pattern => matchPathGlob(pattern, value));
}

// ── Permission Retrieval ──

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
    return DEFAULT_SUBAGENT_PERMISSIONS;
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
  const expanded = canonicalizePath(filePath);
  // N3: also test the symlink-resolved target so a link planted under a writable
  // dir cannot smuggle a write into a globally-denied file (secrets.yaml, the DBs,
  // SOUL.md). Additive + best-effort: on a realpath error realResolveDeepest hands
  // back the lexical path, so this never over-denies a benign write (it only ever
  // ADDS a second target to match against). The FAIL-CLOSED posture belongs to the
  // owner-identity tier (isProtectedIdentityPath); the SOUL/secrets globals stay
  // best-effort because a hard fail-closed here would ride on every agent's write.
  const real = realResolveDeepest(expanded).path;
  for (const pattern of GLOBAL_FILE_WRITE_DENY) {
    if (matchPathGlob(pattern, expanded) || matchPathGlob(pattern, real)) {
      return { allowed: false, reason: `Global deny: writing to ${filePath} is prohibited` };
    }
  }
  return { allowed: true };
}

function checkGlobalDenyFileRead(filePath: string): PermissionResult {
  const expanded = canonicalizePath(filePath);
  for (const pattern of GLOBAL_FILE_READ_DENY) {
    if (matchPathGlob(pattern, expanded)) {
      return {
        allowed: false,
        reason: `Global deny: ${filePath} is restricted. Use the engine helper tools (healer_recent_actions / healer_action_detail) to access this kind of data with bounded response size.`,
      };
    }
  }
  return { allowed: true };
}

function checkGlobalDenyFileDelete(filePath: string): PermissionResult {
  const expanded = canonicalizePath(filePath);
  for (const pattern of GLOBAL_FILE_DELETE_DENY) {
    if (matchPathGlob(pattern, expanded)) {
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
  // v2.3.19 — substring deny for sensitive paths. Catches every form
  // ("~/.dojo/secrets.yaml", "/Users/x/.dojo/secrets.yaml",
  // "$HOME/.dojo/secrets.yaml", or bare "secrets.yaml") regardless of
  // command shape (read, write, redirect, pipe). The path holds API
  // keys — no agent should ever touch it via shell.
  for (const needle of GLOBAL_EXEC_DENY_SUBSTRINGS) {
    // T10: fold so `cat ~/.dojo/Secrets.yaml` — the same file on APFS — is caught.
    if (foldPath(command).includes(needle)) {
      return {
        allowed: false,
        reason: `Global deny: shell commands cannot read or modify ${needle} — this file holds API keys and is protected. Use Settings → Providers in the dashboard to change credentials.`,
      };
    }
  }
  return { allowed: true };
}

function checkFileAccess(manifest: PermissionManifest, filePath: string, accessType: 'file_read' | 'file_write' | 'file_delete'): PermissionResult {
  // Canonicalize once (collapses '..') so the allowlist and the global-deny
  // checks below all match the ACTUAL target the executor will resolve to.
  const expanded = canonicalizePath(filePath);

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
  } else if (accessType === 'file_read') {
    // v2.3.19 — Dreamer-style log discipline; deny direct reads of
    // Healer log files regardless of agent permission manifest.
    const globalCheck = checkGlobalDenyFileRead(expanded);
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

  // FA-P5: canonicalize BOTH sides exactly as the main file check does
  // (canonicalizePath = path.resolve(expandTilde), which collapses '..' and
  // resolves a relative path to absolute). The old expandTilde + startsWith left a
  // squad member using a relative or '..'-form path inside its OWN technique dir
  // wrongly denied, because the un-normalized string did not match the (also
  // un-normalized) dir even though the main file check had already normalized the
  // same path. NOTE: path.resolve is LEXICAL, it does not follow symlinks, which
  // matches canonicalizePath's own semantics, so this stays consistent with the
  // main check rather than introducing a new resolution mode. Compare on a
  // path-segment boundary so /a/b matches /a/b/file but not a sibling /a/bc.
  const canonicalPath = foldPath(canonicalizePath(filePath));
  const canonicalDir = foldPath(canonicalizePath(technique.directory_path));
  return canonicalPath === canonicalDir || canonicalPath.startsWith(canonicalDir + path.sep);
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
          // FA-P5: global deny still applies before any allow. Mirror the
          // file_write squad branch so a globally-denied read (healer logs,
          // secrets.yaml) can never be re-opened by squad workspace access.
          const globalCheck = checkGlobalDenyFileRead(action.path);
          result = globalCheck.allowed ? { allowed: true } : globalCheck;
        }
      }
      break;

    case 'file_write':
      if (!action.path) {
        result = { allowed: false, reason: 'No path specified for file_write' };
      } else if (isTrainerAgent(agentId) && isProtectedIdentityPath(action.path)) {
        // FU-4: the technique trainer holds broad file_write ('*') for technique
        // work, but the owner's identity/profile (USER.md) and platform config
        // stay protected. The manifest schema has no per-agent write deny-list,
        // so this hard-deny lives here, AHEAD of the manifest allow AND the squad
        // fallback below, so neither can re-open it. (file_write/file_patch/
        // file_append all reach checkPermission as type 'file_write', so this one
        // check covers all three write tools.)
        result = { allowed: false, reason: `Global deny: writing to ${action.path} is not permitted (owner identity/config files are protected from the technique trainer)` };
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
      // FA-P4 (option B): the file_delete manifest field and this case are live
      // and correct, but currently UNREACHED, no agent-callable file_delete tool
      // calls checkPermission with this type yet (deletion rides the exec/rm path,
      // which the destructive gate + exec allowlist now handle coherently). The
      // field and case are kept because FU-4's possible scoped-delete tool will
      // gate on exactly this. Do not read the field's existence as a live tool.
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
