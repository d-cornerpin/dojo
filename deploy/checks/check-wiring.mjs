#!/usr/bin/env node
// ════════════════════════════════════════
// Module-level wiring walk (Phase 0 T12d Step 2).
// BLOCKING since the PHASE-1 exit (2026-07-28, T13). It was warn-only for one
// phase, which was long enough to learn what it actually finds.
//
// The orphan gate (T4) works a column at a time: a declared spine column that
// nothing reads. It cannot see a WHOLE MODULE that no longer hangs off any
// entry point, because such a file has no declaration to check against. This
// walk does: start at the four real entry points, follow every static and
// dynamic import, and report the source files the walk never reaches.
//
// ════ WHAT THIS OUTPUT IS NOT ════
// It is NOT a delete list. Roadmap non-negotiable #15 exists because five of
// the six genuinely dangerous errors in this project came from "I looked, I did
// not find it, therefore it is not there." A file this walk does not reach may
// still be:
//   · loaded by a string the walk cannot resolve (a computed import path),
//   · a type-only module erased before any emit,
//   · reached only from a test, which still breaks the build if deleted,
//   · a tool the packaging step copies rather than imports.
// So the wording here is "reached by no entry point walked here" — a QUESTION,
// never a verdict. Reached-only-by-tests is reported as its own category for
// exactly that reason. A removal needs positive evidence this instrument cannot
// supply, and the flip below does NOT change that: the gate never asks anyone to
// delete anything.
//
// ════ WHAT THE FLIP ACTUALLY ENFORCES ════
// It refuses a file that no entry point reaches AND that nobody has written a
// dated line about. The fix is always one of two things, and DELETION IS NOT THE
// DEFAULT one:
//   · wire it (it was supposed to be reachable and now is), or
//   · put it in ALLOWLIST below with a date, an owner and the reason it survives.
// Writing the line costs a sentence. That friction is the whole mechanism: it
// stops a NEW ghost appearing silently, which is the only thing a walk like this
// can honestly police. The five ghosts standing at the flip are all older than
// Phase 1 and every one of them is already booked to a sweep in writing.
//
// Four things fail the build:
//   1. an unreached production file with no allowlist entry;
//   2. a STALE allowlist entry — the file is reached now, or no longer exists.
//      Same anti-rot rule the spine manifest has: the list must keep describing
//      the tree instead of becoming a list of lies;
//   3. a declared entry point that does not exist — the walk ran blind and every
//      list below it is meaningless;
//   4. an unresolved RELATIVE import. That is a hole in the walk: the target was
//      never marked reached, so it and its whole subtree can appear unreached by
//      mistake. A walk with holes reporting green is a false green.
//
// Reached-ONLY-through-a-test never fails. Phase 0 recorded why and roadmap #15
// uses it as its worked example: a test imports it, so deleting it breaks the
// build. Making that category blocking would be pressure to delete live code.
//
// ════ THE WALK SEES FILES THAT ARE NOT COMMITTED YET (backlog 2026-09-27) ════
// It did not, and the cost was a FALSE FAILURE on somebody else's files. The
// enumeration was `git ls-files` alone, so a NEW production module was invisible
// until it was staged — and invisibility here does not under-report, it CORRUPTS:
//
//   · a tracked file importing the new module resolves to nothing, so failure
//     mode 4 fires and the gate announces "2 unresolved relative imports" about
//     a tree with no defect in it (measured: the embeddings lane, 2026-09-27);
//   · worse quietly, the walk cannot pass THROUGH the new module, so every
//     tracked file whose only importer is the new one reads as unreached and can
//     be reported under failure mode 1.
//
// So `git ls-files --others --exclude-standard` joins the enumeration, and the
// two populations are kept apart on purpose:
//
//   RESOLUTION TARGET and WALK-THROUGH NODE — tracked AND untracked. This is the
//   half that closes the hole: the specifier resolves, the walk continues past
//   it, and nothing downstream is slandered.
//
//   JUDGED AS PRODUCTION (failure mode 1, which demands an allowlist line) —
//   TRACKED ONLY. An untracked scratch module nothing imports must not be able
//   to refuse a build; it becomes the walk's business on the commit that adds
//   it, which is the first moment it is anybody's business. Test ROOTS are
//   likewise tracked-only: "reached only through a test" means deleting it
//   breaks the build, and an uncommitted test breaks nobody's build.
//
// ── THE OTHER FIVE `git ls-files` READERS: DECIDED, NOT OVERLOOKED ──
// `check-bytes.mjs`, `check-ratchets.mjs`, `check-growth.mjs`,
// `check-capability-ledger.mjs` and `check-iso-writes.mjs` enumerate the same
// way and KEEP tracked-only, for a reason that is a property of this gate rather
// than of them: each of those measures or ledgers the file it is looking at, so
// an invisible file is a MISSED finding — and the finding arrives intact at the
// commit that tracks it, because `git ls-files` covers staged files. This walk is
// the only one whose verdict about OTHER, tracked files is wrong while a file is
// missing. Widening the others would also make `npm run gates` red on a working
// tree holding an ordinary untracked scratch file, which is a different rule and
// would need the owner, not a gate edit.
//
// Usage: node deploy/checks/check-wiring.mjs [--verbose]
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const VERBOSE = process.argv.includes('--verbose');

// The four things that actually start. `packages/shared` is a library: its
// declared `main` is the entry, which is why it is read from package.json
// rather than guessed.
const ENTRIES = [
  'packages/server/src/index.ts',
  'packages/shared/src/index.ts',
  'packages/dashboard/src/main.tsx',
  'watchdog/src/index.ts',
];

// ════════════════════════════════════════
// THE DATED ALLOWLIST
// ════════════════════════════════════════
// Every entry: the path, the DATE it was added, the OWNER that will resolve it,
// and the reason it survives today. Seeded at the PHASE-1 exit (2026-07-28) with
// the five files the walk has reported since Phase 0 — re-derived at 41fcabb by
// running this walk, not copied from the Phase-0 note.
//
// None of them is a Phase-1 product change: `git log --oneline 4e95125..41fcabb`
// touches none of these five files. They predate the phase and each is already
// booked to a sweep IN WRITING, which is why the owner column is a citation
// rather than a guess.
const ALLOWLIST = [
  {
    path: 'packages/server/src/imaginer/imaginer-agent.ts',
    date: '2026-07-28',
    owner: 'SWEEP-F',
    reason:
      'The Imaginer. SWEEP-G.md:31 books it explicitly — "the Imaginer file (-223, SWEEP-F) and its ' +
      'live residue (owner-gated, SWEEP-F)" — and the owner gate is why it is not simply gone: the ' +
      'residue question is his, not a worker\'s. Phase 0 confirmed it as the research seed expectation.',
  },
  {
    path: 'packages/dashboard/src/components/ActiveJobsIndicator.tsx',
    date: '2026-07-28',
    owner: 'SWEEP-E T5',
    reason:
      'SWEEP-E.md:35 lists it by name in the dead-surface deletion, together with "the 8 stale server ' +
      'comments naming it". Those comments are the reason it must not be deleted piecemeal here: the ' +
      'server still WRITES data for a component nothing renders, and removing the reader without the ' +
      'writer leaves the more expensive half standing.',
  },
  {
    path: 'packages/dashboard/src/components/CostCharts.tsx',
    date: '2026-07-28',
    owner: 'SWEEP-E T5',
    reason:
      'SWEEP-E.md:35, same clause as ActiveJobsIndicator. It is also the SOLE importer of lib/theme.ts ' +
      'below, so the two must be judged together or the walk will simply grow a new ghost.',
  },
  {
    path: 'packages/dashboard/src/lib/theme.ts',
    date: '2026-07-28',
    owner: 'SWEEP-G Step 2',
    reason:
      'SWEEP-G.md:96 names the deletion and its evidence: unreachable from main.tsx, sole importer ' +
      'CostCharts.tsx:1 is itself zero-importer and is Sweep E T5\'s. Two owners, one dependency, ' +
      'already written down in both plans.',
  },
  {
    path: 'packages/server/src/agent/v2/classifiers/index.ts',
    date: '2026-07-28',
    owner: 'PHASE-6',
    reason:
      'A five-line barrel over the classifier modules. SWEEP-G.md:31 books "the agent/v2 classifiers ' +
      '(PHASE-6)". Deleting the barrel alone would save five lines and pre-empt the decomposition that ' +
      'decides what the module boundary should be.',
  },
];

const IN_SCOPE = /^(?:packages\/[^/]+\/src\/|watchdog\/src\/).*\.(?:ts|tsx)$/;
const IS_TEST = (rel) => /(?:^|\/)__tests__\//.test(rel) || /\.(?:test|spec)\.tsx?$/.test(rel);
const IS_DECL = (rel) => rel.endsWith('.d.ts');

function gitPaths(args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

const tracked = () => gitPaths(['ls-files', '-z']);

/**
 * Files in the working tree that git does not track and does not ignore — i.e.
 * exactly the files a developer is about to commit. `--exclude-standard` is what
 * keeps `node_modules`, `dist` and every other ignored path out: without it this
 * would return tens of thousands of paths and the walk would be meaningless.
 */
const untracked = () => gitPaths(['ls-files', '--others', '--exclude-standard', '-z']);

const trackedFiles = tracked();
const untrackedFiles = untracked();
const allFiles = [...trackedFiles, ...untrackedFiles];

const inSource = (r) => IN_SCOPE.test(r) && !IS_DECL(r);
// Everything the walk may resolve to and pass through.
const sourceFiles = allFiles.filter(inSource);
// The narrower population the walk JUDGES. See the header: an uncommitted file
// is a resolution target, never a build-refusing finding.
const trackedSourceFiles = trackedFiles.filter(inSource);
const untrackedSourceFiles = untrackedFiles.filter(inSource);
const fileSet = new Set(sourceFiles);
const trackedSet = new Set(trackedSourceFiles);

// Workspace package name → its source root, so `@dojo/shared` resolves.
const workspaceRoots = new Map();
for (const rel of allFiles.filter((r) => /^(?:packages\/[^/]+|watchdog)\/package\.json$/.test(r))) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (pkg.name) workspaceRoots.set(pkg.name, path.posix.dirname(rel));
  } catch { /* an unreadable manifest is not this check's business */ }
}

/**
 * Blank out comments, preserving offsets. Without this an ordinary apostrophe
 * in prose ("the agent's turn") opens a string as far as the scanner is
 * concerned and the next one closes it, manufacturing specifiers out of
 * commentary — which is exactly what an earlier draft reported.
 */
// ⚠ THE ORDER OF THESE TWO STRIPS IS LOAD-BEARING, AND IT WAS WRONG (PHASE-5 T7).
// Block comments were blanked FIRST, so a `/*` sitting inside a `//` LINE comment
// opened a block comment that ran until the next `*/` anywhere in the file — and
// a header that documents a directory (`tools/cat/*`) contains exactly that. The
// cost was not theoretical: `agent/tools/index.ts` — the executor every tool call
// goes through — had ZERO specifiers extracted, so the walk could not see the
// toolbox at all and 28 files that a header mentions this way were at risk of the
// same silence. It surfaced only when a test-side import was deleted and the one
// module left with no other reader failed the gate. Line comments are stripped
// FIRST now, which cannot mis-open anything, and the block strip runs on what is
// left.
function decomment(src) {
  return src
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, (m, p) => p + ' '.repeat(m.length - p.length)))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// Assets a bundler resolves and a module walk has no business following.
const ASSET = /\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|json|md|txt)$/i;

/** Every import/export specifier in one file, static and dynamic. */
function specifiers(src) {
  const clean = decomment(src);
  const out = [];
  // A specifier never contains a newline; bounding it that way keeps a stray
  // quote from swallowing half the file.
  const push = (s) => { if (s && !ASSET.test(s)) out.push(s); };
  for (const m of clean.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g)) push(m[1]);
  for (const m of clean.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) push(m[1]);
  for (const m of clean.matchAll(/\bimport\s+['"]([^'"\n]+)['"]/g)) push(m[1]);
  for (const m of clean.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) push(m[1]);
  return out;
}

/**
 * Resolve one specifier against a given file set, or null when it is not ours.
 *
 * The SET is a parameter rather than a closure read so the controls at the
 * bottom can drive this exact function over a synthetic tree — the enumeration
 * fix above is only worth having if the resolver can be shown to honour it.
 */
function resolveIn(set, spec, fromRel) {
  let base;
  if (spec.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else {
    // Longest workspace-name match, so `@dojo/shared/foo` works too.
    const hit = [...workspaceRoots.keys()]
      .filter((n) => spec === n || spec.startsWith(n + '/'))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) return null; // node_modules or a node: builtin — not ours
    const rest = spec.slice(hit.length).replace(/^\//, '');
    base = path.posix.join(workspaceRoots.get(hit), rest || 'src/index');
  }

  // TS writes `./x.js` and means `./x.ts`; try the emitted name first.
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  for (const cand of [
    base, stripped,
    `${stripped}.ts`, `${stripped}.tsx`,
    `${stripped}/index.ts`, `${stripped}/index.tsx`,
  ]) {
    if (set.has(cand)) return cand;
  }
  return null;
}

const resolve = (spec, fromRel) => resolveIn(fileSet, spec, fromRel);

/** Breadth-first walk from a set of roots. */
function reachFrom(roots) {
  const seen = new Set();
  const queue = [];
  const unresolved = [];
  for (const r of roots) if (fileSet.has(r)) { seen.add(r); queue.push(r); }
  while (queue.length) {
    const cur = queue.shift();
    let src;
    try { src = fs.readFileSync(path.join(ROOT, cur), 'utf8'); } catch { continue; }
    for (const spec of specifiers(src)) {
      const next = resolve(spec, cur);
      if (next === null) {
        if (spec.startsWith('.')) unresolved.push(`${cur} → ${spec}`);
        continue;
      }
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return { seen, unresolved };
}

// ── The walk ──
const missingEntries = ENTRIES.filter((e) => !fileSet.has(e));
const { seen: reached, unresolved } = reachFrom(ENTRIES);

const production = trackedSourceFiles.filter((r) => !IS_TEST(r));
const unreached = production.filter((r) => !reached.has(r));

// Which of the unreached are reached once tests are allowed to be roots? Those
// are a DIFFERENT category — deleting one breaks the build (#15's worked case).
// TRACKED tests only: that whole category is "a committed test imports it", and
// an uncommitted test cannot break anybody's build but its author's.
const testFiles = trackedSourceFiles.filter(IS_TEST);
const { seen: reachedWithTests } = reachFrom([...ENTRIES, ...testFiles]);
const testOnly = unreached.filter((r) => reachedWithTests.has(r));
const reachedByNothing = unreached.filter((r) => !reachedWithTests.has(r));

// ── Allowlist bookkeeping ──
const allowed = new Map(ALLOWLIST.map((a) => [a.path, a]));
const unexplained = reachedByNothing.filter((r) => !allowed.has(r));
const staleAllowlist = ALLOWLIST.filter((a) => !reachedByNothing.includes(a.path)).map((a) => ({
  ...a,
  why: !fileSet.has(a.path) ? 'the file no longer exists' : 'the file is reached now',
}));
const honouredAllowlist = ALLOWLIST.filter((a) => reachedByNothing.includes(a.path));

// ── Report ──
console.log('Module wiring walk — BLOCKING since the PHASE-1 exit (2026-07-28)');
console.log('');
if (missingEntries.length) {
  console.log(`  ! ${missingEntries.length} declared entry point does not exist: ${missingEntries.join(', ')}`);
  console.log('    The walk ran without it, so its subtree reads as unreached. Fix the list in this file.');
  console.log('');
}
console.log(`  ${ENTRIES.length - missingEntries.length} entry point(s) walked: ${ENTRIES.filter((e) => fileSet.has(e)).join(', ')}`);
console.log(`  ${production.length} production source file(s); ${reached.size} reached by the walk`);
// Printed on every run, including zero, so the enumeration the walk used is a
// stated fact rather than something a reader has to assume.
console.log(
  `  ${untrackedSourceFiles.length} untracked, non-ignored source file(s) joined the walk as resolution `
  + 'targets and walk-through nodes (never judged as production — see this file\'s header)',
);
if (untrackedSourceFiles.length && VERBOSE) {
  for (const r of untrackedSourceFiles) console.log(`     ${r}`);
}
console.log(`  ${testOnly.length} reached ONLY through a test file`);
console.log(`  ${reachedByNothing.length} reached by no entry point and no test`);
console.log('');
console.log('  Reproduce:  node deploy/checks/check-wiring.mjs --verbose');
console.log('');

function byDir(list) {
  const m = new Map();
  for (const r of list) {
    const d = path.posix.dirname(r);
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

if (testOnly.length) {
  console.log('  ── Reached only through a test ──');
  console.log('  These are NOT unused: a test imports them, so removing one breaks the build. They are');
  console.log('  listed because a production module that only tests reach is worth a second look.');
  for (const [dir, list] of byDir(testOnly)) {
    console.log(`     ${dir}/  (${list.length})`);
    for (const r of (VERBOSE ? list : list.slice(0, 5))) console.log(`        ${path.posix.basename(r)}`);
    if (!VERBOSE && list.length > 5) console.log(`        … ${list.length - 5} more (--verbose)`);
  }
  console.log('');
}

if (honouredAllowlist.length) {
  console.log(`  ── ${honouredAllowlist.length} allowlisted ghost(s) — reached by nothing, each with its date and its owner ──`);
  console.log('  This list is the artefact. It never shrinks by itself and it is printed in full on every run.');
  for (const a of honouredAllowlist) {
    console.log(`     ${a.path}`);
    console.log(`        ${a.date} · owner ${a.owner}`);
    console.log(`        ${a.reason}`);
  }
  console.log('');
}

if (unexplained.length) {
  console.log('  ── Reached by no entry point walked here, and by no test, and NOT allowlisted ──');
  console.log('  A QUESTION, not a verdict — and the answer is NOT necessarily deletion. Before anything is');
  console.log('  removed, produce positive evidence: enumerate its readers by command across packages/server');
  console.log('  AND packages/dashboard AND tests, or name the live mechanism that replaced it. An absent');
  console.log('  import is not proof. If it should survive, add it to ALLOWLIST in this file with a date,');
  console.log('  an owner and the reason — that sentence is the whole point of the rule.');
  for (const [dir, list] of byDir(unexplained)) {
    console.log(`     ${dir}/  (${list.length})`);
    for (const r of (VERBOSE ? list : list.slice(0, 8))) {
      let lines = 0;
      try {
        const buf = fs.readFileSync(path.join(ROOT, r));
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
      } catch { /* unreadable: report the name without a size */ }
      console.log(`        ${path.posix.basename(r)}  (${lines} lines)`);
    }
    if (!VERBOSE && list.length > 8) console.log(`        … ${list.length - 8} more (--verbose)`);
  }
  console.log('');
}

if (unresolved.length) {
  const uniq = [...new Set(unresolved)];
  console.log(`  ── ${uniq.length} relative import the walk could NOT resolve ──`);
  console.log('  Every one of these is a hole in the walk: the target was not marked reached, so it and');
  console.log('  everything under it may appear above by mistake. Read these before trusting the lists.');
  for (const u of (VERBOSE ? uniq : uniq.slice(0, 10))) console.log(`     ${u}`);
  if (!VERBOSE && uniq.length > 10) console.log(`     … ${uniq.length - 10} more (--verbose)`);
  console.log('');
}

if (staleAllowlist.length) {
  console.log(`  ── ${staleAllowlist.length} STALE allowlist entr(y/ies) ──`);
  for (const a of staleAllowlist) console.log(`     ${a.path} — ${a.why}`);
  console.log('  Remove the entry in the same commit that changed the fact. The manifest lesson applies');
  console.log('  here too: a list that stops describing the tree rots into a list of lies.');
  console.log('');
}

console.log('  This walk sees static and dynamic imports with literal paths. It does NOT see a computed');
console.log('  specifier, a file the packaging step copies, or a module loaded by name at runtime — so it');
console.log('  raises a question and never answers one. What it enforces is that the question gets an');
console.log('  answer in writing, not that the file gets deleted.');
console.log('');

let failed = false;
const refuse = (msg) => { failed = true; console.error(`✗ wiring walk: ${msg}`); };

// ════════════════════════════════════════
// CONTROLS — the enumeration rule, driven on a SYNTHETIC tree, every run.
// ════════════════════════════════════════
// Same reasoning as `check-gate-manifest.mjs` §7 and `check-must-consume.mjs`'s
// selftest: the rule that an untracked file is a resolution target but not a
// judged production file is the whole fix, and a rule nothing exercises is a
// sentence. These run against hand-built sets, never the real tree, so they are
// deterministic and cost nothing — and they bite in BOTH directions, because a
// "see untracked files" change that simply resolved everything would also pass a
// one-sided check while deleting failure mode 4.
{
  const IMPORTER = 'packages/server/src/importer.ts';
  const NEW_UNTRACKED = 'packages/server/src/brand-new-untracked.ts';
  const trackedOnly = new Set([IMPORTER]);
  const withUntracked = new Set([IMPORTER, NEW_UNTRACKED]);

  const controls = [
    {
      id: 'the-old-blindness-is-reproduced',
      why: 'with a tracked-only set the import of a new module resolves to NOTHING — this is the defect, '
         + 'asserted so the fix below is measured against it rather than against an assumption',
      ok: resolveIn(trackedOnly, './brand-new-untracked.js', IMPORTER) === null,
    },
    {
      id: 'an-untracked-target-resolves',
      why: 'the fix: once the untracked file is in the set, the specifier resolves to it, so failure '
         + 'mode 4 cannot fire about a tree with no defect in it',
      ok: resolveIn(withUntracked, './brand-new-untracked.js', IMPORTER) === NEW_UNTRACKED,
    },
    {
      id: 'a-genuinely-missing-target-is-still-unresolved',
      why: 'the other direction: widening the enumeration must not make the hole detector blind. A '
         + 'specifier naming a file in NEITHER population still returns null and still refuses',
      ok: resolveIn(withUntracked, './does-not-exist-anywhere.js', IMPORTER) === null,
    },
    {
      id: 'an-untracked-file-is-not-judged-as-production',
      why: 'an uncommitted scratch module nothing imports must not be able to refuse a build. Asserted '
         + 'on the REAL populations rather than on the fixture: every judged production path came off '
         + 'the TRACKED list, and the untracked population shares no member with it. (With zero '
         + 'untracked source files the two statements are trivially true — which is honest: there is '
         + 'nothing to tell apart until a file is sitting there)',
      ok: production.every((r) => trackedSet.has(r))
        && untrackedSourceFiles.every((r) => !production.includes(r)),
    },
    {
      id: 'the-production-population-is-not-empty',
      why: 'a tracked-only filter that returned nothing would satisfy the control above by vacuity and '
         + 'turn failure mode 1 off entirely',
      ok: production.length > 100,
    },
    {
      id: 'untracked-files-are-in-the-resolvable-set',
      why: 'the real run, not a fixture: every untracked source file the enumeration found is reachable '
         + 'by the resolver, or the two populations have come apart',
      ok: untrackedSourceFiles.every((r) => fileSet.has(r)),
    },
  ];
  const bad = controls.filter((c) => !c.ok);
  if (bad.length) {
    refuse(`${bad.length} of ${controls.length} enumeration control(s) FAILED — this walk's verdict is unreliable:`);
    for (const c of bad) console.error(`    control "${c.id}": ${c.why}`);
  }
}

if (missingEntries.length) {
  refuse(`${missingEntries.length} declared entry point(s) missing (${missingEntries.join(', ')}) — the walk ran blind, so every list above is meaningless.`);
}
if (unresolved.length) {
  refuse(`${[...new Set(unresolved)].length} unresolved relative import(s) — each is a hole in the walk, and a walk with holes reporting green is a false green.`);
}
if (unexplained.length) {
  refuse(`${unexplained.length} production file(s) reached by no entry point and no test, with no allowlist entry:`);
  for (const r of unexplained) console.error(`    ${r}`);
  console.error('  Wire it, or add {path, date, owner, reason} to ALLOWLIST in this file. Deleting it is a');
  console.error('  THIRD option and it needs positive evidence this walk cannot give you (#15).');
}
if (staleAllowlist.length) {
  refuse(`${staleAllowlist.length} stale allowlist entr(y/ies) — ${staleAllowlist.map((a) => `${a.path} (${a.why})`).join(', ')}.`);
}

if (failed) process.exit(1);
console.log(
  `✓ wiring walk — ${production.length} production file(s), ${reached.size} reached; ` +
  `${testOnly.length} test-only (reported, never blocking); ` +
  `${honouredAllowlist.length} allowlisted with a date and an owner; 0 unexplained`,
);
process.exit(0);
