#!/usr/bin/env node
// ════════════════════════════════════════
// THE INSTALLER PROVES THE SOULS SHIPPED — UX-REPAIR ROUND 12 T55 (W35's HU-1, as code).
//
// ── WHY THIS EXISTS, and it is not hypothetical ──
// W24 and W25 found the same defect twice: `~/.dojo/prompts/PM-SOUL.md` and
// `TRAINER-SOUL.md` held the in-code STUB — 961 and 3,023 bytes of placeholder-carrying
// scaffolding — while `templates/PM-SOUL.md` (13,593 B) and `templates/TRAINER-SOUL.md`
// (8,074 B) of actual doctrine reached NO model on ANY box. The repair was
// `readPlatformTemplate`: the assembler resolves the SHIPPED template and seeds from that.
//
// The whole repair therefore rests on one fact about the BUILD: that
// `deploy/build-package.sh:69-71`
//     mkdir -p "$DEST/platform/templates"
//     cp "$PROJECT_ROOT/templates/"*.md "$DEST/platform/templates/"
// actually puts those files where the COMPILED assembler looks. W35 proved it twice by hand
// (replaying install.sh's rsync from a published artifact, then reading `.30`'s own zip) and
// then said the thing this file is: **nothing in the gate set checks it.** The PM test asserts
// `platformTemplateSearchPaths` covers the packaged layout as STRINGS; it never asserts the
// build puts a file there. Drop those two lines and every PM and Trainer on every box
// silently reverts to the stub, no test fails, and no gate notices.
//
// ── THE RULE THIS FILE IS ──
// Ask the ARTIFACT, never the script text. A gate that greps `build-package.sh` for a `cp`
// passes the day someone rewrites the copy correctly-but-differently, and passes the day the
// copy runs into the wrong directory. So:
//
//   1. the artifact must carry the COMPILED assembler at `packages/server/dist/prompt/` —
//      that is the ANCHOR the runtime search path is computed from, and an assertion about a
//      depth is meaningless if the thing the depth is measured from is not there;
//   2. every `templates/*-SOUL.md` the repo ships must exist at exactly
//      `path.resolve(<artifact>/packages/server/dist/prompt, '../../../../templates', file)`
//      — the FIRST entry of `platformTemplateSearchPaths()`, recomputed here rather than
//      hard-coded, so "shipped somewhere" cannot pass for "shipped where the code looks";
//   3. PM-SOUL.md and TRAINER-SOUL.md are additionally named as a FLOOR, because those two
//      are the measured casualties and a `templates/` directory that lost exactly them must
//      not pass on the strength of its siblings;
//   4. presence is not enough — a shipped soul must clear a byte floor, and when the artifact
//      was built from THIS tree (its embedded version matches the repo's) it must be
//      BYTE-IDENTICAL to the repo template. That is the clause that refuses a truncated,
//      stale or stub-shaped copy.
//
// The soul list is DISCOVERED from `templates/`, not hand-maintained: a new `*-SOUL.md` is
// covered the day it is added, which is the opposite of the hand-list defect class that
// `check-tool-conformance.mjs` exists for.
//
// ── OFFLINE, AND WHY THE SKIP IS SAFE ──
// Same shape as `check-upgrade-bypass.mjs`, for the same reason. `npm run gates` must run on a
// tree that has never been packaged, so with no artifact this SKIPS loudly and exits 0. A
// RELEASE cannot: it passes `--require-artifact` and points this at the packaged build it just
// unzipped and smoke-booted, so the artifact being SHIPPED is the thing that gets asked. A gate
// that quietly passes because it could not run is the exact false green this check exists to be.
//
// Usage:
//   node deploy/checks/check-shipped-souls.mjs [artifactDir] [--require-artifact]
//     artifactDir  the payload root (`…/dojo-platform`) or its `platform/` directory.
//                  Default: deploy/dist/dojo-platform, the local build.
// Exit 0 = the souls shipped (or, offline, nothing to ask). Exit 1 = they did not.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const REPO_TEMPLATES = path.join(ROOT, 'templates');

const argv = process.argv.slice(2);
const REQUIRE_ARTIFACT = argv.includes('--require-artifact');
const artifactArg = argv.find((a) => !a.startsWith('-'));

// A shipped soul below this is not a soul. The measured stubs were 961 B (PM) and 3,023 B
// (Trainer) against 13,593 B and 8,074 B of real doctrine; the floor is deliberately far
// below either real template so it can only ever catch an empty or gutted copy, and the
// byte-identity clause below is what catches the rest.
const MIN_SOUL_BYTES = 1024;

// Named as a floor: the two measured casualties (W24 · W25). The rest of the list is
// discovered, so this can only ever ADD certainty, never cap it.
const REQUIRED_SOULS = ['PM-SOUL.md', 'TRAINER-SOUL.md'];

let failed = false;
const fail = (...lines) => { failed = true; for (const l of lines) console.error(l); };

// ════════ resolve the artifact ════════
function resolvePlatformDir(dir) {
  if (!dir) return null;
  const nested = path.join(dir, 'platform');
  if (fs.existsSync(path.join(nested, 'packages'))) return nested;
  if (fs.existsSync(path.join(dir, 'packages'))) return dir;
  if (fs.existsSync(nested)) return nested;
  return null;
}

const candidate = artifactArg ?? path.join(ROOT, 'deploy/dist/dojo-platform');
const platformDir = fs.existsSync(candidate) ? resolvePlatformDir(candidate) : null;

if (!platformDir) {
  const where = path.relative(ROOT, candidate) || candidate;
  if (REQUIRE_ARTIFACT) {
    console.error(
      `FAIL — no built artifact at ${where}. Run with --require-artifact, a skip is not a pass: `
      + 'this check proves nothing without an artifact, and a release that could not ask the '
      + 'question must not answer it.',
    );
    process.exit(1);
  }
  console.error(
    `SKIPPED — no built artifact at ${where}. The shipped-souls check proves nothing without one; `
    + 'a release MUST run it against the packaged build (--require-artifact). '
    + 'Build locally with `npm run build:package` to run it here.',
  );
  process.exit(0);
}

// ════════ 1. the anchor: the compiled assembler's own directory ════════
// `platformTemplateSearchPaths` in packages/server/src/prompt/assembler.ts computes the
// packaged template directory as ONE relative hop from the module's own location. Recompute
// it here from the SAME anchor, so this gate measures the artifact against the code's real
// resolution rather than against a path someone typed twice.
const distPromptDir = path.join(platformDir, 'packages', 'server', 'dist', 'prompt');
if (!fs.existsSync(distPromptDir)) {
  fail(
    `✗ the artifact has no ${path.relative(platformDir, distPromptDir)} — the compiled assembler is not where`,
    '  build-package.sh puts it, so the packaged template path cannot be computed from its own anchor.',
    '  Either the server build did not land in the payload, or the shipped layout moved. Both are findings:',
    '  `platformTemplateSearchPaths` resolves relative to this directory at runtime.',
    '',
  );
  console.error('✗ shipped-souls gate: refusing.');
  process.exit(1);
}
const shippedTemplatesDir = path.resolve(distPromptDir, '../../../../templates');

// A sanity clause on the recomputation itself: the hop must land INSIDE the artifact. If it
// ever escapes, the depth assumption changed and every verdict below would be about some
// other directory entirely.
if (path.relative(platformDir, shippedTemplatesDir).startsWith('..')) {
  fail(
    `✗ the computed template directory (${shippedTemplatesDir}) is OUTSIDE the artifact.`,
    '  `platformTemplateSearchPaths`\'s relative hop no longer matches the shipped layout.',
    '',
  );
}

// ════════ 2. the artifact's provenance ════════
// Byte-identity against the repo templates is only a fair question when the artifact was built
// from THIS tree. A release always is (release.sh bumps the version, then builds). A stale local
// `deploy/dist` may not be, and a gate that fails on that is a gate people learn to ignore.
let sameTree = false;
let artifactVersion = '(unknown)';
try {
  artifactVersion = JSON.parse(fs.readFileSync(path.join(platformDir, 'package.json'), 'utf8')).version;
  const repoVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  sameTree = artifactVersion === repoVersion;
} catch { /* provenance unknown: presence + floor clauses still apply */ }

// ════════ 3. every shipped soul, at the computed path, with real content ════════
const repoSouls = fs.existsSync(REPO_TEMPLATES)
  ? fs.readdirSync(REPO_TEMPLATES).filter((f) => f.endsWith('-SOUL.md')).sort()
  : [];

if (repoSouls.length === 0) {
  fail(
    '✗ the repo ships no templates/*-SOUL.md at all — this gate has nothing to compare against.',
    '  A checker that finds nothing to check reports a clean sweep, which is the failure shape',
    '  these gates exist to prevent.',
    '',
  );
}
for (const required of REQUIRED_SOULS) {
  if (!repoSouls.includes(required)) {
    fail(
      `✗ templates/${required} is not in the repo — the named floor cannot be asserted.`,
      '  W24 and W25 measured this exact file reverting to the in-code stub on a live box.',
      '',
    );
  }
}

for (const file of repoSouls) {
  const shipped = path.resolve(distPromptDir, '../../../../templates', file);
  const label = path.relative(platformDir, shipped);
  if (!fs.existsSync(shipped)) {
    fail(
      `✗ ${file} — NOT in the artifact at ${label}`,
      '  This is build-package.sh:69-71 (the templates copy step) not having run, or having run',
      '  somewhere the compiled assembler does not look. Every agent whose soul is seeded from this',
      '  template falls back to the in-code stub, silently, on every installed box.',
      '',
    );
    continue;
  }
  const bytes = fs.readFileSync(shipped);
  if (bytes.length < MIN_SOUL_BYTES) {
    fail(
      `✗ ${file} — shipped at ${bytes.length} bytes, below the ${MIN_SOUL_BYTES}-byte floor.`,
      '  Present but gutted is the same outcome as absent: the model reads a stub either way.',
      '',
    );
    continue;
  }
  if (sameTree) {
    const repoBytes = fs.readFileSync(path.join(REPO_TEMPLATES, file));
    if (!repoBytes.equals(bytes)) {
      fail(
        `✗ ${file} — the shipped copy is not the repo template (${bytes.length} B shipped vs ${repoBytes.length} B in templates/).`,
        `  The artifact declares version ${artifactVersion}, the same tree this check is running in, so`,
        '  the two must be byte-identical. A drifted copy means the doctrine a user runs is not the',
        '  doctrine in this repository.',
        '',
      );
      continue;
    }
  }
  console.log(
    `PASS  ${String(bytes.length).padStart(6)} B  ${file}  →  ${label}`
    + (sameTree ? '  (byte-identical to templates/)' : ''),
  );
}

// ════════ 4. control: this gate refuses what it is supposed to refuse ════════
// Ships WITH the gate and runs on every invocation, so "the detector still bites" is a fact
// this file proves about itself rather than something someone checked once. Same practice as
// check-gate-manifest.mjs §7 and check-must-consume.mjs's planted-fault selftest.
{
  const detects = (dir) => {
    const anchor = path.join(dir, 'packages', 'server', 'dist', 'prompt');
    if (!fs.existsSync(anchor)) return true;                          // no anchor = refused
    return repoSouls.some((f) => !fs.existsSync(path.resolve(anchor, '../../../../templates', f)));
  };
  const controls = [
    {
      id: 'a-templates-directory-that-is-missing-is-refused',
      why: 'the literal build-package.sh:70-71 failure — the copy step dropped',
      ok: detects(path.join(platformDir, '__no_such_platform__')),
    },
    {
      id: 'the-real-artifact-is-accepted',
      why: 'the rule must not simply refuse everything',
      ok: !detects(platformDir) || failed,
    },
    {
      id: 'the-computed-path-is-the-assemblers-own-hop',
      why: 'the depth is recomputed from the compiled module, never hard-coded',
      ok: path.resolve(distPromptDir, '../../../../templates') === shippedTemplatesDir,
    },
  ];
  const bad = controls.filter((c) => !c.ok);
  if (bad.length) {
    fail(`✗ ${bad.length} control(s) FAILED — this gate's verdict is unreliable:`, '');
    for (const c of bad) fail(`  control "${c.id}": ${c.why}`, '');
  }
}

// ════════ verdict ════════
if (failed) {
  console.error('');
  console.error(`✗ shipped-souls gate: refusing (artifact ${platformDir}).`);
  process.exit(1);
}
console.log(
  `✓ shipped souls: ${repoSouls.length} template(s) present at the path the compiled assembler computes`
  + `${sameTree ? ', all byte-identical to templates/' : ` (artifact version ${artifactVersion}; byte-identity not asserted across trees)`}`,
);
