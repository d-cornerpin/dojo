// The path leaf: brokers resolve paths here without importing permissions.ts, which re-exports them.

import path from 'node:path';
import fs from 'node:fs';
import { PROTECTED_IDENTITY_PATHS } from './sensei-policy.js';
import { foldPath } from './fs-case.js';
import { homeDir } from '../home.js';

/** Expand `~` / `~/…` / `~user` to a home-relative path; anything else passes through unchanged. */
export function resolveHomePath(inputPath: string): string {
  if (inputPath === '~') return homeDir();
  if (inputPath.startsWith('~/')) return path.join(homeDir(), inputPath.slice(2));
  if (inputPath.startsWith('~')) return path.join(homeDir(), '..', inputPath.slice(1));
  return inputPath;
}

export function expandTilde(pattern: string): string {
  const home = homeDir();
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return home + pattern.slice(1);
  return pattern;
}

// expandTilde does NOT collapse '..': '~/Projects/../.dojo/secrets.yaml' string-matches an
// allowlist yet resolves to the protected target. path.resolve folds '..' so checks see the real file.
export function canonicalizeAgentPath(filePath: string): string {
  return path.resolve(expandTilde(filePath));
}

// path.resolve is LEXICAL: a planted symlink under an allowed dir can point INTO a protected
// file and defeat the prefix match. Resolve the deepest EXISTING ancestor's real path (both
// realpathSync and existsSync follow links), re-append the tail. Errors return { resolved:false }.
function realResolveDeepest(lexicalAbs: string, depth = 0): { path: string; resolved: boolean } {
  // Link-loop guard: a chain of broken links re-enters this function per hop.
  if (depth > 8) return { path: lexicalAbs, resolved: false };
  let existing = lexicalAbs;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    // existsSync FOLLOWS links, so a BROKEN one reads as missing and the walk would step past it;
    // a write through it creates its target under a protected dir. lstat finds it; resolve its target.
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

/** Existing DIRECTORY? Lives in the fs leaf: its one caller must not import node:fs itself. */
export function isExistingDirectory(inputPath: string): boolean {
  try {
    return fs.statSync(resolveHomePath(inputPath)).isDirectory();
  } catch {
    return false;
  }
}

// For outside callers: canonicalize, THEN resolve links. { resolved:false } means the caller MUST fail closed.
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

// Identity/config file check: canonicalize FIRST (collapse '..') so a traversal resolves before
// the prefix match, then re-check through symlinks; FAIL-CLOSED: unresolvable under ~/.dojo = protected.
export function isProtectedIdentityPath(filePath: string): boolean {
  const lexical = canonicalizeAgentPath(filePath);
  if (PROTECTED_IDENTITY_PATHS.some(pattern => matchAgentPathGlob(pattern, lexical))) return true;
  const { path: real, resolved } = realResolveDeepest(lexical);
  if (!resolved) return isUnderProtectedRoot(lexical);
  return PROTECTED_IDENTITY_PATHS.some(pattern => matchAgentPathGlob(pattern, real));
}

/** Glob matcher: * = within one segment (any text when starCrossesSlash, for command lines),
 *  ** = any number of segments, ? = one character. */
export function matchAgentGlob(pattern: string, value: string, starCrossesSlash = false): boolean {
  const expandedPattern = expandTilde(pattern);
  const expandedValue = expandTilde(value);

  let regex = '';
  let i = 0;
  while (i < expandedPattern.length) {
    const ch = expandedPattern[i];

    if (ch === '*') {
      if (i + 1 < expandedPattern.length && expandedPattern[i + 1] === '*') {
        i += 2;
        if (i < expandedPattern.length && expandedPattern[i] === '/') {
          regex += '(?:.*/)?';
          i++;
        } else {
          regex += '.*';
        }
      } else {
        regex += starCrossesSlash ? '[\\s\\S]*' : '[^/]*';
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
    return expandedPattern === expandedValue;
  }
}

// The glob regex is case-SENSITIVE, so on APFS '~/.dojo/Secrets.yaml' slips every deny pattern
// while opening the same bytes. Expand '~' on BOTH sides first, then fold; exec deny stays strict.
export function matchAgentPathGlob(pattern: string, value: string): boolean {
  return matchAgentGlob(foldPath(expandTilde(pattern)), foldPath(expandTilde(value)));
}
