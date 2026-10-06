// ════════════════════════════════════════════════════════════════════════════════════════
// ONE IMPORT DIRECTION FOR THE MANIFEST — t107 (t92 review, Minor 5).
//
// ── THE FINDING, MEASURED ──
// `agent/brokers/sudo-claim.ts` asks `getAgentPermissions` whether the primary holds any
// command grant at all (that is the whole sudo claim: a `sudo` line is a command, so an agent
// with no command grant may not knock). `agent/tools/surface.ts` asks the SAME question about
// the SAME agent, two lines before it asks the door. They read it through two different
// modules: the door from `agent/manifest.js`, where the function is DECLARED, and the surface
// from `agent/permissions.js`, which re-exports it.
//
// Two spellings of one module are two modules to a test, and the cost was real:
// `tools/__tests__/the-primary-exec-description-names-the-sudo-door.test.ts` — the suite that
// exists BECAUSE a live blast found the sudo sentence missing twice — mocked `permissions.js`.
// Its planted `exec_allow` therefore steered the surface and never reached the door, so every
// clause about WHO MAY KNOCK was answered by the unmocked production manifest instead of by
// the fixture. The suite was green and half of it was measuring the wrong thing.
//
// ── WHAT THIS FILE HOLDS ──
//  1. THE CENSUS, both ways: the two readers' `getAgentPermissions` import RESOLVES TO ONE
//     FILE. It is not a string match on a preferred spelling — the specifier is resolved to an
//     absolute path on disk, so `../manifest.js`, `../../manifest.js` and a future relocation
//     all compare equal, while `permissions.js` (a real file that really re-exports it) does
//     not. Presence is asserted first and separately: a reader that stops importing the
//     function at all fails here rather than passing a comparison of two nulls.
//  2. THE DIRECTION, stated once: the module that DECLARES the function is the one both read.
//     `permissions.js` is an adapter whose own header says every name it exported is still
//     exported from it; routing a reader through it buys nothing and costs an edge.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

/** The two readers, by the job each does with the answer. */
const READERS = [
  { label: 'the sudo claim door', file: path.join(SRC, 'brokers/sudo-claim.ts') },
  { label: 'the tool surface', file: path.join(SRC, 'tools/surface.ts') },
] as const;

/** Where this tree keeps the declaration — asserted below, never assumed. */
const DECLARING_MODULE = path.join(SRC, 'manifest.ts');

/**
 * The module specifier a file imports `getAgentPermissions` from, resolved against the file's
 * own directory and with the runtime `.js` extension mapped back to the `.ts` on disk.
 *
 * COMMENTS ARE STRIPPED FIRST (G4). This file's own header quotes both spellings, and so does
 * the comment now sitting above each of the two imports; a scan that read prose would pass on
 * the strength of a sentence about the defect.
 */
function manifestImportOf(file: string): string | null {
  const src = fs.readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const m = src.match(/import\s*\{[^}]*\bgetAgentPermissions\b[^}]*\}\s*from\s*'([^']+)'/);
  if (!m) return null;
  const resolved = path.resolve(path.dirname(file), m[1]);
  return resolved.replace(/\.js$/, '.ts');
}

describe('the sudo door and the tool surface read ONE manifest module', () => {
  it('both readers really do import getAgentPermissions (presence, before any comparison)', () => {
    for (const { label, file } of READERS) {
      expect(manifestImportOf(file), `${label} (${path.relative(SRC, file)}) imports getAgentPermissions`)
        .not.toBeNull();
    }
  });

  it('the two imports resolve to the SAME file on disk', () => {
    const [door, surface] = READERS.map(r => manifestImportOf(r.file));
    expect(surface).toBe(door);
  });

  it('and that file is the module which DECLARES the function, not a re-export of it', () => {
    expect(fs.existsSync(DECLARING_MODULE)).toBe(true);
    expect(fs.readFileSync(DECLARING_MODULE, 'utf-8')).toMatch(/export function getAgentPermissions\b/);
    for (const { label, file } of READERS) {
      expect(manifestImportOf(file), `${label} reads the declaring module`).toBe(DECLARING_MODULE);
    }
  });

  it('`agent/permissions.ts` is still a re-export, so the two spellings really were interchangeable', () => {
    // The direction is a TIDINESS fix, not a behaviour fix, and this clause is what says so: if
    // the adapter ever stops re-exporting the same function, the two readers were answering
    // different questions all along and the change above needs re-arguing rather than keeping.
    const adapter = fs.readFileSync(path.join(SRC, 'permissions.ts'), 'utf-8');
    expect(adapter).toMatch(/export\s*\{[^}]*\bgetAgentPermissions\b[^}]*\}\s*from\s*'\.\/manifest\.js'/);
  });
});
