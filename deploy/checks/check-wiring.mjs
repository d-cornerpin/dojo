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

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

const allFiles = tracked();
const sourceFiles = allFiles.filter((r) => IN_SCOPE.test(r) && !IS_DECL(r));
const fileSet = new Set(sourceFiles);

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
function decomment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, (m, p) => p + ' '.repeat(m.length - p.length)))
    .join('\n');
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

/** Resolve one specifier to a tracked source path, or null when it is not ours. */
function resolve(spec, fromRel) {
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
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

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

const production = sourceFiles.filter((r) => !IS_TEST(r));
const unreached = production.filter((r) => !reached.has(r));

// Which of the unreached are reached once tests are allowed to be roots? Those
// are a DIFFERENT category — deleting one breaks the build (#15's worked case).
const testFiles = sourceFiles.filter(IS_TEST);
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
