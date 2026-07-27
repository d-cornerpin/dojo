// ════════════════════════════════════════
// Path guards — one place for "is this path allowed to leave the box?"
// (PHASE-0 T10)
// ════════════════════════════════════════
//
// Two jobs, both previously scattered or missing:
//
//   1. CASE FOLDING. Every sensitive-path comparison in this codebase was
//      written case-sensitively (exact basename match, `startsWith('secret')`,
//      `path.join` equality, `matchGlob` with no /i). APFS — the filesystem the
//      platform actually runs on — is case-INSENSITIVE, so `~/.dojo/Secrets.yaml`
//      opens the very same bytes as `~/.dojo/secrets.yaml` while matching none of
//      the four guards. Four layers sharing one assumption is one layer
//      (`../overhaul-research/22-remediation-reconciliation.md` §3). The fold is
//      driven by a BOOT PROBE, never by `process.platform`: the question is what
//      the filesystem does, and a Linux box (or a case-sensitive APFS volume)
//      must NOT fold, or every legitimately capitalised path becomes a false
//      block.
//
//   2. THE SHARE GATE. `share_file` / `share_publicly` / the pdf_* tools all read
//      an arbitrary path and hand its bytes somewhere the agent chose — a public
//      URL, the model's context. `file_read` and `file_patch` have refused
//      sensitive paths for a long time; these three simply never asked. They ask
//      here now, through the same `isSensitivePath` list and the same
//      `checkPermission('file_read')` the read tools use.
//
// This module deliberately imports nothing from the platform except a logger:
// `permissions.ts` reads `foldPath` from here, so a static import back the other
// way would be a cycle. The one thing that needs `checkPermission` loads it
// dynamically, the same idiom `tools.ts` already uses for that module.

import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('path-guards');

// ── Filesystem case sensitivity ──

/** The three `node:fs` calls the probe needs. Injected so the boot caller owns
 *  the fs import (this module stays effect-free) and so the unit test can drive
 *  BOTH outcomes without a real case-insensitive volume to test on. */
export interface ProbeFs {
  writeFileSync(file: string, data: string): void;
  existsSync(file: string): boolean;
  unlinkSync(file: string): void;
}

// null = not yet probed. The getter treats that as "fold" (see below).
let fsCaseInsensitive: boolean | null = null;

/**
 * Probe whether `dir` lives on a case-insensitive filesystem: write `…-A.tmp`,
 * ask whether `…-a.tmp` exists, clean up. The pid is in the name so two
 * processes probing the same directory cannot answer each other's question.
 *
 * Returns false when the probe cannot run at all (unwritable dir) — a failed
 * probe is not evidence of case-insensitivity, and the caller keeps whatever
 * the flag already held.
 */
export function probeFsCaseInsensitive(dir: string, fsImpl: ProbeFs): boolean {
  const upper = path.join(dir, `dojo-fscase-${process.pid}-A.tmp`);
  const lower = path.join(dir, `dojo-fscase-${process.pid}-a.tmp`);
  try {
    fsImpl.writeFileSync(upper, 'fs case probe');
    return fsImpl.existsSync(lower);
  } catch (err) {
    logger.warn('Filesystem case probe failed; keeping the current fold setting', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    // On a case-insensitive volume `upper` and `lower` are the same inode, so
    // one unlink clears both names.
    try { fsImpl.unlinkSync(upper); } catch { /* nothing to clean up */ }
  }
}

/** Record the probe's answer. Called once at boot; called by tests to cover
 *  both filesystems. */
export function setFsCaseInsensitive(value: boolean): void {
  fsCaseInsensitive = value;
}

/**
 * Does this box fold case in path names?
 *
 * Before the boot probe has run this answers TRUE — fail closed. Folding when
 * we should not costs an over-block on a file literally named `Secrets.yaml`;
 * not folding when we should costs every sensitive-path guard at once. Boot
 * replaces the guess with a measurement within milliseconds of start-up.
 */
export function isFsCaseInsensitive(): boolean {
  return fsCaseInsensitive ?? true;
}

/** Lower-case a path (or a command line containing one) when — and only when —
 *  the filesystem itself ignores case. Identity on a case-sensitive box. */
export function foldPath(value: string): string {
  return isFsCaseInsensitive() ? value.toLowerCase() : value;
}

// ── Path resolution ──

/** Expand `~` / `~/…` to the home directory. Everything else passes through
 *  unchanged (callers check `path.isAbsolute` themselves). */
export function resolvePath(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  if (inputPath.startsWith('~')) return path.join(os.homedir(), '..', inputPath.slice(1));
  return inputPath;
}

// ── The sensitive-file list ──

// Files that must NEVER appear in tool output, and must never be published to a
// share URL. CLAUDE.md is explicit: "Secrets never enter the database or memory
// DAG. API keys and tokens live in ~/.dojo/secrets.yaml ... They never appear in
// message content, tool results, or summaries." Any file_read / file_patch /
// file_list / exec / share / pdf path that would echo one of these gets refused
// at the tool boundary, before the model sees it (and before the audit_log
// writes the result into the conversation).
//
// Match by basename (cheap, robust against absolute vs. relative paths) plus a
// few directory containment checks. Entries are lower-case: every comparison
// below runs through foldPath, so on a case-folding filesystem `.ENV` and
// `Secrets.yaml` match too.
const SENSITIVE_BASENAMES = new Set<string>([
  'secrets.yaml',
  'secrets.yml',
  'secrets.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'authorized_keys',
  'known_hosts',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
]);

export function isSensitivePath(absPath: string): boolean {
  const base = foldPath(path.basename(absPath));
  const folded = foldPath(absPath);
  const home = foldPath(os.homedir());
  if (SENSITIVE_BASENAMES.has(base)) return true;
  // Anything under ~/.ssh/ except the public key whitelist is sensitive.
  const sshDir = path.join(home, '.ssh');
  if (folded.startsWith(sshDir + path.sep) && !base.endsWith('.pub')) return true;
  // ~/.aws/credentials, ~/.config/gcloud/, ~/.kube/config, common cred locations.
  if (folded === path.join(home, '.aws', 'credentials')) return true;
  if (folded.startsWith(path.join(home, '.config', 'gcloud') + path.sep)) return true;
  if (folded === path.join(home, '.kube', 'config')) return true;
  // Anything matching the secrets.yaml extension pattern in ~/.dojo/.
  if (folded.startsWith(path.join(home, '.dojo') + path.sep) && base.startsWith('secret')) return true;
  return false;
}

// ── The share / read gate ──

/**
 * The verdict shape the share and pdf call sites consume.
 *
 * `blockedMessage === null` means the refusal came from the PERMISSION layer,
 * not the sensitive-file list: the caller renders it with its own
 * `permissionDeniedMessage()` so the agent-facing guidance is byte-identical to
 * every other permission block it has ever seen (agents parse these strings —
 * `agent/v2/loop.ts` keys retry behaviour off the `[BLOCKED]` prefix).
 */
export type SharePathVerdict =
  | { allowed: true; absPath: string }
  | { allowed: false; absPath: string; reason: string; blockedMessage: string | null };

/**
 * resolve → isSensitivePath (case-folded) → checkPermission('file_read').
 * Every path a tool is about to READ OUT — publish to a URL, extract into the
 * model's context — goes through here first.
 */
export async function sharePathGuard(
  agentId: string,
  toolName: string,
  rawPath: string,
): Promise<SharePathVerdict> {
  const absPath = resolvePath(rawPath);

  if (isSensitivePath(absPath)) {
    return {
      allowed: false,
      absPath,
      reason: 'sensitive path block list',
      blockedMessage:
        `[BLOCKED] ${toolName} refused: ${absPath} is on the sensitive-files block list ` +
        `(secrets.yaml, .env files, SSH keys, cloud credentials). The DOJO never publishes ` +
        `secret files or reads them into the conversation. If you need a value from this file, ` +
        `ask the user, those values live in process memory only.`,
    };
  }

  // Dynamic on purpose: permissions.ts imports foldPath from this module, so a
  // static import here would close a cycle.
  const { checkPermission } = await import('./permissions.js');
  const perm = checkPermission(agentId, { type: 'file_read', path: absPath });
  if (!perm.allowed) {
    return {
      allowed: false,
      absPath,
      reason: perm.reason ?? `file_read not allowed for path: ${absPath}`,
      blockedMessage: null,
    };
  }

  return { allowed: true, absPath };
}

/**
 * Every path a pdf_* call would READ: `path` (most tools), `input_paths`
 * (pdf_merge), and the `path` on pdf_create's image content blocks. Output
 * filenames are excluded — those are resolved into the agent's own upload
 * directory by pdf-tools.ts and never name a caller-chosen location.
 */
export function pdfInputPaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) out.push(value);
  };
  push(args.path);
  if (Array.isArray(args.input_paths)) for (const p of args.input_paths) push(p);
  if (Array.isArray(args.content)) {
    for (const block of args.content) {
      if (block && typeof block === 'object') push((block as { path?: unknown }).path);
    }
  }
  return out;
}
