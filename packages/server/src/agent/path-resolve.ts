// ════════════════════════════════════════════════════════════════════════════
// PATH CANONICALIZATION AND GLOB MATCHING — a leaf (PHASE-5 T2).
//
// Extracted verbatim from `agent/permissions.ts` so the brokers can resolve a
// path without importing the module that is about to become their reader. Every
// function below is byte-for-byte what it was at `16bd0b8`; `permissions.ts`
// re-exports the three names that were already public (`matchGlob`,
// `resolveRealPathHardened`, `isProtectedIdentityPath`) so no consumer moved.
//
// The comments are the originals, because they are the record of WHY each of
// these is shaped the way it is — every one of them is a fixed incident.
// ════════════════════════════════════════════════════════════════════════════

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PROTECTED_IDENTITY_PATHS } from './sensei-policy.js';
import { foldPath } from './fs-case.js';

/** Expand `~` / `~/…` / `~user` to a home-relative path. Everything else passes
 *  through unchanged (callers check `path.isAbsolute` themselves). Moved here
 *  from `path-guards.ts`, which re-exports it as `resolvePath`, so the process
 *  broker can expand a token without importing the share gate. */
export function resolveHomePath(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  if (inputPath.startsWith('~')) return path.join(os.homedir(), '..', inputPath.slice(1));
  return inputPath;
}

export function expandTilde(pattern: string): string {
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
export function canonicalizeAgentPath(filePath: string): string {
  return path.resolve(expandTilde(filePath));
}

// N3: canonicalizeAgentPath (path.resolve) is LEXICAL, it does not follow
// symlinks. The Trainer now holds exec + file_write '*', so it could plant a
// symlink under an allowed dir that points INTO a protected file and defeat the
// lexical prefix match. Resolve the DEEPEST EXISTING ancestor's real path
// (fs.realpathSync follows symlinks; fs.existsSync also follows them, so the
// walk stops at the nearest node that truly resolves), then re-append the
// non-existent tail. A symlinked file resolves in full; a symlinked directory in
// the middle resolves and the remaining tail rides on the real target. Never
// throws: realpath errors return { resolved:false } so callers pick their own
// posture (fail-closed for the identity tier, best-effort-additive for the
// globals). Cheap enough for the file-write path (a few stat syscalls, no I/O on
// the common lexical-hit fast path).
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
// auto-approve gate): expandTilde + collapse '..' (canonicalizeAgentPath) THEN
// resolve symlinks / broken links (realResolveDeepest), the exact pipeline
// isProtectedIdentityPath uses. { resolved:false } means resolution failed and the
// caller MUST fail closed (treat the target as out-of-zone / protected).
/**
 * Does this tilde-expanded path name an existing DIRECTORY?
 *
 * Lives here rather than in its one caller (`tools/process-run.ts`, the exec
 * doors' `cwd` check) for one reason: this module is already an fs leaf and the
 * toolbox is not. `no-restricted-imports` is advisory today and T7's exit gate
 * flips it to ENFORCED once nothing outside the brokers and these leaves reaches
 * `node:fs`, so a NEW direct `node:fs` import in the toolbox would be a step
 * away from that gate on the exact task that is meant to move toward it.
 */
export function isExistingDirectory(inputPath: string): boolean {
  try {
    return fs.statSync(resolveHomePath(inputPath)).isDirectory();
  } catch {
    return false;
  }
}

export function resolveRealPathHardened(filePath: string): { path: string; resolved: boolean } {
  return realResolveDeepest(canonicalizeAgentPath(filePath));
}

// The protected-identity tier lives entirely under ~/.dojo; a candidate under that
// root whose symlinks cannot be resolved is treated as protected (fail-closed).
function isUnderProtectedRoot(lexicalAbs: string): boolean {
  const root = foldPath(canonicalizeAgentPath('~/.dojo'));
  const candidate = foldPath(lexicalAbs);
  return candidate === root || candidate.startsWith(root + path.sep);
}

// FU-4 + N3: is this write target one of the owner's identity/config files
// (PROTECTED_IDENTITY_PATHS)? Canonicalize FIRST (collapse '..') so a traversal
// such as '~/.dojo/techniques/../prompts/USER.md' resolves before the prefix
// match, then re-check through symlinks so a planted link into a protected path is
// caught (see realResolveDeepest). FAIL-CLOSED: if symlink resolution errors for a
// candidate under the protected root, treat it as protected. Consumed two ways: a
// hard write-deny for the Trainer (the fs broker) and a destructive-classify
// signal for the Healer (destructive-gate.ts).
export function isProtectedIdentityPath(filePath: string): boolean {
  const lexical = canonicalizeAgentPath(filePath);
  if (PROTECTED_IDENTITY_PATHS.some(pattern => matchAgentPathGlob(pattern, lexical))) return true;
  const { path: real, resolved } = realResolveDeepest(lexical);
  if (!resolved) return isUnderProtectedRoot(lexical);
  return PROTECTED_IDENTITY_PATHS.some(pattern => matchAgentPathGlob(pattern, real));
}

/**
 * Simple glob matcher supporting:
 * - * matches any characters within a single path segment (no /)
 * - ** matches any number of path segments (including zero)
 * - ? matches a single character
 */
export function matchAgentGlob(pattern: string, value: string): boolean {
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

// PHASE-0 T10 (see agent/fs-case.ts): matchAgentGlob's regex is case-SENSITIVE,
// so on APFS '~/.dojo/Secrets.yaml' slipped every deny pattern while opening the
// same bytes. Expand '~' on BOTH sides first — matchAgentGlob would otherwise
// re-expand a folded pattern back into a mixed-case absolute — then fold. Paths
// only; the exec global-deny still matches command shapes case-sensitively.
export function matchAgentPathGlob(pattern: string, value: string): boolean {
  return matchAgentGlob(foldPath(expandTilde(pattern)), foldPath(expandTilde(value)));
}

export function matchesAnyPathGlob(patterns: string[], value: string): boolean {
  return patterns.some(pattern => matchAgentPathGlob(pattern, value));
}
