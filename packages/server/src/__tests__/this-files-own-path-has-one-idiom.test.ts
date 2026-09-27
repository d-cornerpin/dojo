// ════════════════════════════════════════════════════════════════════════════════════════
// A MODULE ASKS WHERE IT IS WITH `fileURLToPath`, AND NEVER WITH `.pathname`.
//
// ── THE INCIDENT, AND WHY NOTHING CAUGHT IT ──
// The v3.2.1 release gate went red on `a-deleted-thing-keeps-no-embedding.test.ts` §6, and only
// in the LIVE tree. The line was `path.dirname(new URL(import.meta.url).pathname)`. A `file:`
// URL is PERCENT-ENCODED: this repo's real path contains spaces, so `.pathname` answered
// `/Users/…/Claude%20Code%20Projects/Agent%20Dojo%20Refresh/dojo/…` and the migration file it
// resolved "did not exist".
//
// What makes it worth a census rather than a fix: **every worktree verification in this campaign
// ran under a space-free scratchpad**, so the defect was not merely unnoticed, it was
// STRUCTURALLY INVISIBLE to the way this work is checked. A clause that only fails on one
// developer's directory layout is not a guard. This one reads the SOURCE, so it fails everywhere.
//
// ── AND IT WAS NOT ONLY A TEST ──
// The same sweep found the same line in TWO SHIPPED PRODUCT FILES — `voice/model-manager.ts` and
// `voice/tts-service.ts`, both deriving the repo root to find a legacy model cache. Any user
// whose install path has a space in it (`~/My Apps/dojo`, `~/Library/Application Support/…`) lost
// that lookup silently: no error, just a 330 MB re-download or a cache the dashboard cannot see.
//
// ── THE RULE IS ABSOLUTE HERE, WHICH IS WHY IT IS A CENSUS AND NOT A REVIEW NOTE ──
// `.pathname` on a `file:` URL is ALWAYS wrong for filesystem work: percent-encoding, and on
// Windows a leading `/` before the drive letter. `fileURLToPath` is the decode-and-denormalise
// that Node ships for exactly this. There is no legitimate use in this repo — `LEGITIMATE` below
// is empty, and it is a table rather than an absence so that the day someone needs one they add a
// row with a reason instead of deleting the clause.
//
// ⚠ WHAT THIS DOES NOT FLAG, deliberately: `new URL('../x', import.meta.url)` handed straight to
// `fs.readFileSync`, which Node accepts as a URL and decodes itself. That form is correct and is
// used in dozens of places; the defect is specifically turning the URL into a STRING by hand.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file's own directory — by the idiom this file exists to enforce. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repo root: `packages/server/src/__tests__` → up four. */
const REPO = path.resolve(HERE, '../../../..');

/** Where source lives. Build output (`dist/`, `deploy/dist/`) is generated and gitignored. */
const ROOTS = [
  'packages/server/src', 'packages/shared/src', 'packages/dashboard/src',
  'watchdog/src', 'deploy/checks', 'scripts',
];

/**
 * A use of `.pathname` on an `import.meta.url`-derived URL that has been argued and accepted.
 * EMPTY, on purpose: there is no such use in this repo. A row needs `{ rel, line, why }`.
 */
const LEGITIMATE: ReadonlyArray<{ rel: string; why: string }> = [];

const CODE_EXT = /\.(?:ts|tsx|mjs|cjs|js)$/;

function walk(absDir: string, relDir: string, out: string[] = []): string[] {
  if (!fs.existsSync(absDir)) return out;
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, e.name);
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(abs, rel, out);
    } else if (CODE_EXT.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** Comments stripped: this file's own header talks about the pattern in prose. */
const codeOf = (rel: string): string =>
  fs.readFileSync(path.join(REPO, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) out.push(...walk(path.join(REPO, root), root));
  return out;
}

describe('a module asks where it is with fileURLToPath', () => {
  it('no source file turns `import.meta.url` into a path by hand', () => {
    const files = sourceFiles();
    // Non-vacuity first: a walk that found nothing would pass this clause for free, and the
    // walk is the whole instrument.
    expect(files.length, 'the source walk found no code at all').toBeGreaterThan(500);

    const allowed = new Set(LEGITIMATE.map(l => l.rel));
    const offenders: string[] = [];
    for (const rel of files) {
      if (allowed.has(rel)) continue;
      codeOf(rel).split('\n').forEach((line, i) => {
        // The two shapes of hand-surgery: `.pathname` off a URL built from import.meta.url, and
        // string mangling of the URL itself (`.replace('file://', '')`, `.slice(7)`, …).
        const pathnameSurgery = /import\.meta\.url[^;\n]*\)\s*\.pathname|new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/.test(line);
        const stringSurgery = /import\.meta\.url\s*\.\s*(?:replace|slice|substring|split)\(/.test(line)
          || /decodeURIComponent\([^)]*import\.meta\.url/.test(line);
        if (pathnameSurgery || stringSurgery) offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'a `file:` URL is percent-encoded, so `.pathname` (and hand-decoding it) breaks on any path '
      + 'with a space — which is EVERY path in this repo, and every user install under `~/My Apps` '
      + 'or `~/Library/Application Support`. Use `fileURLToPath(import.meta.url)`. This exact line '
      + 'turned the v3.2.1 release gate red and shipped broken in two voice files. If a use is '
      + 'genuinely legitimate, add it to LEGITIMATE with its reason.',
    ).toEqual([]);
  });

  it('the exemption table is empty, and says so rather than being absent', () => {
    // The point of an empty table: the next person needing one writes a reason. If a row ever
    // appears, it must name a file that exists and still holds the pattern.
    for (const row of LEGITIMATE) {
      expect(fs.existsSync(path.join(REPO, row.rel)), `LEGITIMATE names a missing file: ${row.rel}`).toBe(true);
      expect(row.why.length, `LEGITIMATE row for ${row.rel} has no reason`).toBeGreaterThan(30);
    }
    expect(LEGITIMATE.length, 'a row was added — read the reason, then delete this expectation').toBe(0);
  });

  it('⚠ THE REPRODUCTION, in one assertion: the two idioms DISAGREE on a spaced path', () => {
    // This is the whole bug, at unit level, independent of where the suite happens to run. It is
    // also the clause that would have caught the voice files without a spaced checkout.
    const spaced = '/Users/dave/Claude Code Projects/Agent Dojo Refresh/dojo/packages/server/src/voice/x.ts';
    const url = new URL(`file://${encodeURI(spaced)}`).href;

    expect(new URL(url).pathname, 'the defect: %20 survives into what is used as a filesystem path')
      .toContain('%20');
    expect(fileURLToPath(url), 'the law: fileURLToPath decodes back to the real path').toBe(spaced);
    expect(new URL(url).pathname).not.toBe(fileURLToPath(url));

    // And the derivation the two voice files actually do — four levels up to the repo root — is
    // right under the law and wrong under the defect.
    const REPO_ROOT_OF = (p: string) => path.resolve(path.dirname(p), '../../../..');
    expect(REPO_ROOT_OF(fileURLToPath(url))).toBe('/Users/dave/Claude Code Projects/Agent Dojo Refresh/dojo');
    expect(REPO_ROOT_OF(new URL(url).pathname), 'the shipped defect derived a directory that does not exist')
      .toContain('%20');
  });

  it('the two shipped voice files use the law, by name', () => {
    // Named because these two are PRODUCT: a regression here is a user losing a 330 MB cache
    // lookup with no error message, not a red suite.
    for (const rel of ['packages/server/src/voice/model-manager.ts', 'packages/server/src/voice/tts-service.ts']) {
      const src = codeOf(rel);
      expect(/fileURLToPath\(import\.meta\.url\)/.test(src), `${rel} no longer uses fileURLToPath`).toBe(true);
      expect(/\.pathname/.test(src), `${rel} is back to hand-built paths`).toBe(false);
    }
  });
});
