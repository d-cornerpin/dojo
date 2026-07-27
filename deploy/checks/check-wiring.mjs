#!/usr/bin/env node
// ════════════════════════════════════════
// Module-level wiring walk (Phase 0 T12d Step 2). WARN-ONLY — never fails.
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
// exactly that reason. Warn-only by design; a removal needs positive evidence
// that this instrument cannot supply.
//
// Usage: node deploy/checks/check-wiring.mjs [--verbose]
// Always exits 0.
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

// ── Report ──
console.log('Module wiring walk — WARN ONLY (this check never fails a build)');
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

if (reachedByNothing.length) {
  console.log('  ── Reached by no entry point walked here, and by no test ──');
  console.log('  A QUESTION, not a verdict. Before anything is removed, produce positive evidence:');
  console.log('  enumerate its readers by command across packages/server AND packages/dashboard AND');
  console.log('  tests, or name the live mechanism that replaced it. An absent import is not proof.');
  for (const [dir, list] of byDir(reachedByNothing)) {
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

console.log('  Warn-only by design. This walk sees static and dynamic imports with literal paths. It');
console.log('  does NOT see a computed specifier, a file the packaging step copies, or a module loaded');
console.log('  by name at runtime — so it can raise a question and never answer one.');
process.exit(0);
