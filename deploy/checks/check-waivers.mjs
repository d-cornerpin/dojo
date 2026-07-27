#!/usr/bin/env node
// ════════════════════════════════════════
// Waiver counter (Phase 0 T12d Step 4c). THIS CAN FAIL AN ARC.
//
// The strategy document's answer to the risk "gates get waived":
//
//   "every waiver is a counted commit trailer; more than ~5 across Arc 1 means
//    the rule is wrong and we fix the rule, not the habit."
//
// That sentence is the pre-committed consequence. This is the counter that
// makes it a number the build reads, so the promise cannot quietly lapse.
//
// ════ THE TRAILER ════
// One spelling, so there is one thing to count:
//
//   Gate-Waiver: <gate-name> — <why this commit is allowed past it>
//
// A git trailer: last paragraph of the commit message, one per line. The gate
// name and a reason are both REQUIRED; a bare `Gate-Waiver:` is rejected as
// malformed and counted, because an unexplained waiver is the worst kind.
//
// ════ WHO OWNS WHICH COUNT ════
// Two surfaces can excuse a gate, and they are layered, not duplicated:
//   · commit trailers — a one-off, "this commit may pass"; counted here.
//   · `spine-manifest.json` waivers — a standing exemption for one spine entry;
//     enforced by check-orphans.mjs, which prints its own local n/5.
// THIS script is the only place the ARC TOTAL is computed, across both. When
// the two disagree about the budget, this one is the number that decides.
//
// ════ WHAT THE FAILURE MEANS ════
// It is NOT "you may not waive". Over budget, the finding is that the RULE is
// wrong — a gate being waived six times is a gate mis-scoped, and the fix is to
// change the gate, not to stop writing the trailer. The refusal says so, because
// a counter that reads as "stop admitting it" produces silent bypasses instead.
//
// Usage:
//   node deploy/checks/check-waivers.mjs [--since <sha>] [--budget <n>] [--verbose]
// Env: DOJO_ARC_BASE overrides the arc base.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const sinceArg = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : undefined;
const budgetArg = argv.includes('--budget') ? Number(argv[argv.indexOf('--budget') + 1]) : undefined;

// Arc 1 starts at the pre-phase HEAD — the commit this branch was measured
// from. Verified 2026-07-27:
//   git log --oneline 1b3f5f7 -1   → 1b3f5f7 release: v3.1.17-preflight.22
// Arc 2 (the sweeps) passes its own base with --since.
const DEFAULT_BASE = '1b3f5f7';
const BASE = sinceArg ?? process.env.DOJO_ARC_BASE ?? DEFAULT_BASE;
const BUDGET = Number.isFinite(budgetArg) ? budgetArg : 5;

const TRAILER = /^Gate-Waiver:[ \t]*(.*)$/;
const MANIFEST_REL = 'deploy/checks/spine-manifest.json';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

let baseSha;
try {
  baseSha = git(['rev-parse', '--verify', `${BASE}^{commit}`]).trim();
} catch {
  console.error(`✗ waiver counter cannot run: arc base "${BASE}" does not resolve in this repo.`);
  console.error('  Pass it explicitly:  --since <sha>   (or set DOJO_ARC_BASE)');
  process.exit(1);
}

// ── Commit trailers over the arc ──
// A record separator that cannot occur in a message, so multi-line bodies parse.
const SEP = '<<<COMMIT>>>';
const raw = git(['log', `--format=${SEP}%H%n%cI%n%s%n%b`, `${baseSha}..HEAD`]);
const commits = raw.split(SEP).filter((c) => c.trim()).map((chunk) => {
  const lines = chunk.replace(/^\n/, '').split('\n');
  return { sha: lines[0], date: lines[1], subject: lines[2], body: lines.slice(3) };
});

const wellFormed = [];
const malformed = [];
for (const c of commits) {
  for (const line of c.body) {
    const m = TRAILER.exec(line.trim());
    if (!m) continue;
    const value = m[1].trim();
    // Require a gate name AND a reason, separated by an em dash, en dash or a
    // hyphen surrounded by spaces. "Which gate, and why" is the whole content.
    const split = /^(\S[^—–]*?)\s*[—–]\s*(.+)$|^(\S.*?)\s+-\s+(.+)$/.exec(value);
    const rec = {
      sha: c.sha.slice(0, 8),
      date: (c.date ?? '').slice(0, 10),
      subject: c.subject,
      value,
      gate: split ? (split[1] ?? split[3]).trim() : null,
      reason: split ? (split[2] ?? split[4]).trim() : null,
    };
    if (rec.gate && rec.reason) wellFormed.push(rec);
    else malformed.push(rec);
  }
}

// ── Standing waivers in the spine manifest ──
let manifestWaivers = [];
let manifestRead = false;
const manifestPath = path.join(ROOT, MANIFEST_REL);
if (fs.existsSync(manifestPath)) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifestWaivers = Array.isArray(m.waivers) ? m.waivers : [];
    manifestRead = true;
  } catch { /* check-orphans owns validating this file; a parse failure is its refusal, not ours */ }
}

const trailerCount = wellFormed.length + malformed.length;
const total = trailerCount + manifestWaivers.length;

// ── Report ──
console.log('Waiver counter — the pre-committed consequence, as a number');
console.log('');
console.log(`  arc base ${BASE} (${baseSha.slice(0, 10)}) → HEAD, ${commits.length} commit(s)`);
console.log('');
console.log(`     commit trailers   ${String(trailerCount).padStart(4)}${malformed.length ? `   (${malformed.length} malformed)` : ''}`);
console.log(`     standing waivers  ${String(manifestWaivers.length).padStart(4)}   ${manifestRead ? MANIFEST_REL : `${MANIFEST_REL} not read`}`);
console.log(`     ──────────────────────`);
console.log(`     arc total         ${String(total).padStart(4)}  /  ${BUDGET}`);
console.log('');
console.log('  Reproduce the trailer count:');
console.log(`     git log --format='%H %s%n%b' ${BASE}..HEAD | command grep -c '^Gate-Waiver:'`);
console.log('');

if (wellFormed.length) {
  console.log('  Waivers on record:');
  for (const w of (VERBOSE ? wellFormed : wellFormed.slice(0, 20))) {
    console.log(`     ${w.sha}  ${w.date}  [${w.gate}]  ${w.reason}`);
  }
  if (!VERBOSE && wellFormed.length > 20) console.log(`     … ${wellFormed.length - 20} more (--verbose)`);
  console.log('');
}

if (manifestWaivers.length) {
  console.log(`  Standing waivers in ${MANIFEST_REL} (enforced by check-orphans.mjs):`);
  for (const w of manifestWaivers) console.log(`     ${w.entry} — ${w.date}: ${w.reason}`);
  console.log('');
}

let failed = false;

if (malformed.length) {
  failed = true;
  console.error(`✗ ${malformed.length} malformed Gate-Waiver trailer(s) — each needs a gate AND a reason:`);
  for (const w of malformed) console.error(`     ${w.sha}  ${w.date}  "Gate-Waiver: ${w.value}"`);
  console.error('  The required shape is:   Gate-Waiver: <gate-name> — <why this commit is allowed past it>');
  console.error('  An unexplained waiver is the worst kind: it spends the budget and records nothing a');
  console.error('  later reader can argue with. These are counted against the budget regardless.');
  console.error('');
}

if (total > BUDGET) {
  failed = true;
  console.error(`✗ ${total} waivers across this arc, over the budget of ${BUDGET}.`);
  console.error('');
  console.error('  The pre-committed reading of this number, from the strategy document:');
  console.error('     more than ~5 across an arc means THE RULE IS WRONG.');
  console.error('');
  console.error('  So the fix is the gate, not the habit. A gate waived six times is mis-scoped:');
  console.error('  narrow it, re-aim it, or retire it — and delete the waivers it no longer needs.');
  console.error('  Do NOT respond by stopping the trailers; an uncounted bypass is worse than a');
  console.error('  counted one, and it is the exact failure this counter exists to make impossible.');
  console.error('');
}

if (failed) process.exit(1);

console.log(`✓ waivers within budget — ${total}/${BUDGET} across the arc`);
if (total === 0) {
  console.log('  No gate has been waived since the arc base. Nothing to fix, and nothing hidden:');
  console.log('  a zero here is only meaningful because the trailer is the one recorded way to waive.');
}
process.exit(0);
