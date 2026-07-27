#!/usr/bin/env node
// ════════════════════════════════════════
// Net-production accounting (Phase 0 T12d Step 3). REPORT-ONLY on a number.
//
// ════ THIS CHECK NEVER FAILS A BUILD ON AN ARITHMETIC RESULT ════
// Owner ruling, 2026-07-26, superseding the arithmetic audit's proposal:
//   "That will just lead to you hallucinating or omitting needed lines of code
//    to get it passed. Functionality is more important."
// The old "deleted >= added" gate is retired and is NOT replaced by a budget.
// It was satisfiable by pure relocation anyway — a file split scores 1.0 while
// zero lines leave the tree, and a large share of this plan's headline
// deletions are moves.
//
// So it reports THREE numbers — gross deleted, gross added, net production —
// and has exactly one active behaviour: when net production is POSITIVE it
// says so and names the files driving it, so the phase's exit review can
// answer the only question that matters:
//
//     what did this replace, and is the old thing gone?
//
// Net-positive with a complete accounting is fine; some phases legitimately
// grow. Net-positive that CANNOT say what it replaced is the disease this
// project exists to cure, and that is what stops a phase — a judgement made by
// a human against the demolition ledger, never by this script against a
// threshold.
//
// `--require-accounting` is the ONLY way this exits non-zero, and even then the
// failure is "a net-positive file has no demolition-ledger entry", not a number.
// Phase 0 runs it without that flag; Phase 1 onward turns it on.
//
// ════ IT REFUSES ON A DIRTY TREE ════
// T2 Step 0's rule. The kit's dev instruments patch five of the exact files
// this measures; a figure taken with them installed is fiction. A refusal is
// the correct output for an unmeasurable tree.
//
// Usage:
//   node deploy/checks/check-deletion-ratio.mjs [--base <sha>] [--require-accounting] [--verbose]
// Env: DOJO_PHASE_BASE overrides the base; DOJO_DEMOLITION_LEDGER the ledger path.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const REQUIRE_ACCOUNTING = argv.includes('--require-accounting');
const baseArg = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined;

// Phase 0's base is the pre-phase HEAD — the commit this branch was measured
// from. Phase 0 has no Task T0 (that convention starts at Phase 1), so it is
// recorded here rather than read out of an AS-BUILT note. Verified 2026-07-27:
//   git log --oneline 1b3f5f7 -1     → 1b3f5f7 release: v3.1.17-preflight.22
//   git merge-base 1b3f5f7 HEAD      → 1b3f5f789ea73f9b22184079160894ca256d968f
// From Phase 1 the executing task passes --base with the sha in its T0 note.
const DEFAULT_BASE = '1b3f5f7';
const BASE = baseArg ?? process.env.DOJO_PHASE_BASE ?? DEFAULT_BASE;

// The demolition record (roadmap non-negotiable #9). It lives in the workspace
// beside the repo, deliberately not inside it.
const LEDGER = process.env.DOJO_DEMOLITION_LEDGER
  ?? path.join(ROOT, '..', 'archive', 'previous-agent-docs', 'DOJO-SCAR-TISSUE-LEDGER.md');

// The plan's exact pathspec: rename/copy detection so relocations do not count,
// tests and generated migrations excluded.
const PATHSPEC = ["':!**/__tests__/**'", "':!**/*.test.ts'", "':!packages/server/src/db/migrations/**'"];
const PATHSPEC_ARGS = PATHSPEC.map((p) => p.slice(1, -1));
const NUMSTAT_ARGS = ['diff', '-M', '-C', '--find-copies-harder', '--numstat', `${BASE}..HEAD`, '--', ...PATHSPEC_ARGS];
const PRINTABLE = `git ${NUMSTAT_ARGS.slice(0, -PATHSPEC_ARGS.length).join(' ')} ${PATHSPEC.join(' ')}`;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// ── Refuse on a dirty tree ──
const dirty = git(['status', '--short']).trim();
if (dirty) {
  const lines = dirty.split('\n');
  console.error('✗ net-production accounting REFUSES to report: the working tree is not clean.');
  console.error('');
  console.error(`  ${lines.length} uncommitted change(s):`);
  for (const l of lines.slice(0, 12)) console.error(`     ${l}`);
  if (lines.length > 12) console.error(`     … ${lines.length - 12} more`);
  console.error('');
  console.error('  The kit\'s dev instruments patch five of the very files this measures, so a figure');
  console.error('  taken over a dirty tree describes neither the committed code nor the instrumented');
  console.error('  one. Commit, stash, or uninstall the instruments, then re-run:');
  console.error('     node ../dojo-test-kit/server-instruments/uninstall.mjs && git status --short');
  console.error('');
  console.error('  Refusing is the correct output here, not a failure of the measurement.');
  process.exit(1);
}

// ── Confirm the base exists and is an ancestor ──
let baseSha;
try {
  baseSha = git(['rev-parse', '--verify', `${BASE}^{commit}`]).trim();
} catch {
  console.error(`✗ net-production accounting cannot run: base commit "${BASE}" does not resolve in this repo.`);
  console.error('  Pass the phase base explicitly:  --base <sha>   (or set DOJO_PHASE_BASE)');
  process.exit(1);
}
let isAncestor = true;
try {
  git(['merge-base', '--is-ancestor', baseSha, 'HEAD']);
} catch {
  isAncestor = false;
}

// ── Measure ──
const numstat = git(NUMSTAT_ARGS).trim();
const rows = [];
let added = 0;
let deleted = 0;
for (const line of numstat ? numstat.split('\n') : []) {
  const [a, d, ...rest] = line.split('\t');
  // A binary file reports "-" for both counts; it has no lines to account for.
  if (a === '-' || d === '-') continue;
  const file = rest.join('\t');
  const ai = Number(a);
  const di = Number(d);
  added += ai;
  deleted += di;
  rows.push({ file, added: ai, deleted: di, net: ai - di });
}
const net = added - deleted;
const headSha = git(['rev-parse', '--short', 'HEAD']).trim();
const commits = git(['rev-list', '--count', `${baseSha}..HEAD`]).trim();

// ── Report ──
console.log('Net-production accounting — a REPORT, never a pass/fail on the number');
console.log('');
console.log(`  base ${BASE} (${baseSha.slice(0, 10)})  →  HEAD ${headSha}     ${commits} commit(s)`);
if (!isAncestor) {
  console.log('  ! the base is NOT an ancestor of HEAD — the range is a symmetric difference, not a');
  console.log('    phase\'s work. Check the base before quoting any number below.');
}
console.log('');
console.log(`     gross added      ${String(added).padStart(8)}`);
console.log(`     gross deleted    ${String(deleted).padStart(8)}`);
console.log(`     ────────────────────────`);
console.log(`     net production   ${String(net).padStart(8)}${net > 0 ? '   ← positive' : ''}`);
console.log('');
console.log(`  across ${rows.length} file(s). Reproduce exactly:`);
console.log(`     ${PRINTABLE}`);
console.log('');
console.log('  Rename/copy detection is on, so a relocation nets zero rather than scoring as both a');
console.log('  deletion and an addition. Tests and generated migrations are outside the pathspec.');
console.log('');

// Where the change landed. Reported so the exit review can see at a glance
// whether growth is product or instruments — NOT deducted from any total.
const AREAS = [
  ['deploy/ (gates and release machinery)', /^deploy\//],
  ['packages/server/src', /^packages\/server\/src\//],
  ['packages/dashboard/src', /^packages\/dashboard\/src\//],
  ['packages/shared/src', /^packages\/shared\/src\//],
  ['watchdog/', /^watchdog\//],
  ['scripts/ and templates/', /^(?:scripts|templates)\//],
];
const areaRows = AREAS.map(([label, re]) => {
  const hit = rows.filter((r) => re.test(r.file));
  return { label, files: hit.length, added: hit.reduce((s, r) => s + r.added, 0), deleted: hit.reduce((s, r) => s + r.deleted, 0) };
}).filter((a) => a.files > 0);
const claimed = areaRows.reduce((s, a) => s + a.files, 0);
if (areaRows.length) {
  console.log('  Where it landed (informational; nothing is deducted from the totals above):');
  for (const a of areaRows.sort((x, y) => (y.added - y.deleted) - (x.added - x.deleted))) {
    console.log(`     ${a.label.padEnd(38)} ${String(a.added - a.deleted).padStart(7)} net   (+${a.added} / −${a.deleted}, ${a.files} file(s))`);
  }
  if (claimed < rows.length) console.log(`     ${'elsewhere'.padEnd(38)} ${String(rows.length - claimed).padStart(7)} file(s)`);
  console.log('');
}

// ── The one active behaviour ──
const growers = rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);
let uncovered = [];

if (net > 0) {
  console.log('  NET POSITIVE — exit review must account for this');
  console.log('');
  console.log(`  ${growers.length} file(s) grew. The largest:`);
  for (const g of (VERBOSE ? growers : growers.slice(0, 15))) {
    console.log(`     +${String(g.net).padStart(6)}   ${g.file}   (+${g.added} / −${g.deleted})`);
  }
  if (!VERBOSE && growers.length > 15) console.log(`     … ${growers.length - 15} more (--verbose)`);
  console.log('');
  console.log('  The question the review answers, file by file: WHAT DID THIS REPLACE, AND IS THE OLD');
  console.log('  THING GONE? The proof is the demolition ledger\'s "requirement preserved:" line plus');
  console.log('  the phase\'s grep-zero list — never a number. A phase may legitimately grow; a phase');
  console.log('  that cannot say what it replaced is the adding-without-deleting disease.');
  console.log('');
} else {
  console.log(`  Net production is ${net}. No accounting obligation is triggered by the number itself;`);
  console.log('  the demolition ledger still owes a "requirement preserved:" line for every removal.');
  console.log('');
}

// ── --require-accounting: the only non-zero exit ──
if (REQUIRE_ACCOUNTING) {
  console.log('  ── --require-accounting ──');
  if (!fs.existsSync(LEDGER)) {
    console.error(`  ✗ the demolition ledger is not at ${LEDGER}`);
    console.error('    Refusing rather than passing: a missing ledger is not evidence that every');
    console.error('    net-positive file is accounted for. Point at it with DOJO_DEMOLITION_LEDGER.');
    process.exit(1);
  }
  const ledger = fs.readFileSync(LEDGER, 'utf8');
  // Coverage is textual and deliberately generous: the file's path OR its
  // basename appearing anywhere in the ledger counts as an entry. A generous
  // match means every failure below is a file NOTHING in the ledger mentions.
  uncovered = growers.filter((g) => {
    const bare = path.posix.basename(g.file);
    return !ledger.includes(g.file) && !ledger.includes(bare);
  });
  console.log(`  ledger: ${path.relative(ROOT, LEDGER)}`);
  console.log(`  ${growers.length} net-positive file(s); ${growers.length - uncovered.length} named in the ledger; ${uncovered.length} not named`);
  if (uncovered.length) {
    console.error('');
    console.error(`  ✗ ${uncovered.length} net-positive file(s) have no demolition-ledger entry:`);
    for (const u of (VERBOSE ? uncovered : uncovered.slice(0, 20))) {
      console.error(`     +${String(u.net).padStart(6)}   ${u.file}`);
    }
    if (!VERBOSE && uncovered.length > 20) console.error(`     … ${uncovered.length - 20} more (--verbose)`);
    console.error('');
    console.error('  This is the adding-without-deleting check, not an arithmetic one. Each file above');
    console.error('  grew and the record does not say what it replaced. Add the entry with its');
    console.error('  "requirement preserved:" line, or state in the exit review why the growth is new');
    console.error('  capability replacing nothing.');
    process.exit(1);
  }
  console.log('  ✓ every net-positive file is named in the demolition ledger.');
  console.log('');
}

process.exit(0);
