// path-resolve.ts is the leaf every allow/deny decision on an agent file path
// runs through: expand the tilde forms, canonicalize a file path before a
// match, and the glob matcher itself. It was extracted verbatim from
// agent/permissions.ts (PHASE-5 T2) and re-exported the three names that were
// already public, but no v35 test pins the glob/tilde behaviour itself — every
// test that touches a path goes through a tool door, not these primitives.
//
// These pin the primitives in isolation. homeDir() is the private per-worker
// home the suite hands every process (src/home.ts); we never hard-code a user
// path. The case-folding half is driven by setFsCaseInsensitive
// (src/agent/fs-case.ts), reset to its untouched default (case-insensitive — the
// boot probe's fail-closed guess) after every test so a fold here cannot leak
// into a sibling in the same worker.
//
// NOT tested here: resolveRealPathHardened / isProtectedIdentityPath — they walk
// the real filesystem and are the fs broker's own job, not these pure primitives.

import { describe, it, expect, afterEach } from 'vitest';
import { homeDir } from '../../home.js';
import {
  expandTilde, resolveHomePath, canonicalizeAgentPath, matchAgentGlob, matchAgentPathGlob,
} from '../path-resolve.js';
import { setFsCaseInsensitive } from '../fs-case.js';

afterEach(() => {
  // Its untouched default is case-insensitive (isFsCaseInsensitive treats "not
  // yet probed" as fold). Restore it so a case-sensitive fold above cannot leak
  // into a sibling test sharing this worker.
  setFsCaseInsensitive(true);
});

// ════════════════════════════════════════
// The tilde helpers
// ════════════════════════════════════════

describe('expandTilde', () => {
  it('a bare ~ is the home', () => {
    expect(expandTilde('~')).toBe(homeDir());
  });

  it('~/x joins onto the home', () => {
    expect(expandTilde('~/x')).toBe(`${homeDir()}/x`);
  });

  it('a ~user token passes through untouched (expandTilde only handles bare ~)', () => {
    expect(expandTilde('~x')).toBe('~x');
  });

  it('a ~ in the middle of an absolute path is left alone', () => {
    expect(expandTilde('/a/~')).toBe('/a/~');
  });
});

describe('resolveHomePath', () => {
  it('a bare ~ is the home', () => {
    expect(resolveHomePath('~')).toBe(homeDir());
  });

  it('~/x joins onto the home', () => {
    expect(resolveHomePath('~/x')).toBe(`${homeDir()}/x`);
  });

  it('a ~user token is a sibling of the home, not a child of it', () => {
    // ~user → path.join(home, '..', user): the user name is resolved against the
    // home PARENT, so ~x lands beside home, ending in /x.
    expect(resolveHomePath('~x')).toMatch(/\/x$/);
  });

  it('a relative path passes through untouched', () => {
    expect(resolveHomePath('rel/x')).toBe('rel/x');
  });
});

describe('canonicalizeAgentPath', () => {
  it('collapses a .. traversal before the allow/deny match sees the target', () => {
    // expandTilde expands ~ but does NOT collapse ..; canonicalizeAgentPath
    // (path.resolve) does, so a ~/Projects/../.dojo/… traversal resolves to the
    // real target the allowlist and the global deny both match.
    expect(canonicalizeAgentPath('~/Projects/../.dojo/s.yaml')).toBe(`${homeDir()}/.dojo/s.yaml`);
  });
});

// ════════════════════════════════════════
// The glob matcher itself — literal regex characters stay literal
// ════════════════════════════════════════

// * is single-segment, ** crosses segments, ? is one char, and the regex
// metacharacters are all escaped so a pattern names itself rather than a class.
const GLOB_CASES: [string, string, boolean][] = [
  ['/a/*.ts', '/a/x.ts', true],
  ['/a/*.ts', '/a/b/x.ts', false],
  ['/a/**', '/a/b/c', true],
  ['/a/**/x.ts', '/a/x.ts', true],
  ['/a/**/x.ts', '/a/b/c/x.ts', true],
  ['/a/?.ts', '/a/b.ts', true],
  ['/a/?.ts', '/a/bc.ts', false],
  ['/a/b.ts', '/a/bXts', false], // the dot is literal
  ['/a/(x)', '/a/(x)', true],
  ['/a/[x]', '/a/x', false],
  ['/a/[x]', '/a/[x]', true],
  ['/a/{x,y}', '/a/x', false],
  ['/a/+', '/a/+', true], // the regex character is literal
];

describe('matchAgentGlob', () => {
  it.each(GLOB_CASES)('%s vs %s -> %s', (pattern, value, expected) => {
    expect(matchAgentGlob(pattern, value)).toBe(expected);
  });
});

// ════════════════════════════════════════
// The case fold — matchAgentPathGlob, driven by the measured filesystem
// ════════════════════════════════════════

describe('matchAgentPathGlob folds case with the filesystem, not the platform', () => {
  it('a capitalised name matches a lower-case glob on a case-insensitive fs', () => {
    setFsCaseInsensitive(true);
    expect(matchAgentPathGlob('~/.dojo/*.YAML', '~/.dojo/Secrets.yaml')).toBe(true);
  });

  it('a capitalised name does NOT match on a case-sensitive fs', () => {
    setFsCaseInsensitive(false);
    expect(matchAgentPathGlob('~/.dojo/*.YAML', '~/.dojo/Secrets.yaml')).toBe(false);
    // The lower-case glob does not match a capitalised value either.
    expect(matchAgentPathGlob('~/.dojo/secrets.yaml', '~/.dojo/Secrets.yaml')).toBe(false);
  });
});
