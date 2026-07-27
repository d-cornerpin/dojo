#!/usr/bin/env node
// ════════════════════════════════════════
// Lint-baseline gate (Phase 0 T3).
//
// This repo had no eslint config until now, and the findings that appeared the
// moment one existed are in the hundreds. Making them errors would make the tree
// unshippable on day one, and an unshippable gate gets bypassed and then deleted.
// So the rules are all `warn` and THIS is the enforcement:
//
//   lint-baseline.json pins today's count FOR EACH RULE. A count may fall. It
//   may never rise. Fixing findings is free; adding one fails the build.
//
// PER-RULE, not just totals, on purpose — the same argument as the size-ratchet
// manifest. A single grand total lets 40 new floating promises hide behind 40
// deleted fs imports, and the number that is supposed to be a ratchet becomes a
// number that is merely stable.
//
// Two measurements, one baseline:
//   1. eslint over packages/server/src  → counts keyed by rule id
//   2. tsc -p tsconfig.lint.json        → counts keyed by TS diagnostic code
//      (noUnusedLocals/noUnusedParameters live ONLY in that config, never in the
//      build, so the unused-symbol population is counted without breaking `npm
//      run build` or `npm run typecheck`.)
//
// Every pinned number in lint-baseline.json is stored beside the exact command
// that produced it (roadmap non-negotiable #14: a count with no command beside
// it is a rumour). Re-run the command by hand and you get the number back.
//
// Usage:
//   node deploy/checks/check-lint-baseline.mjs             # check; exit 1 on any rise
//   node deploy/checks/check-lint-baseline.mjs --tighten   # lower pins to reality, then check
//
// --tighten only ever LOWERS, and it never ADDS an entry. Admitting a new rule,
// or raising a ceiling, is a deliberate hand edit to lint-baseline.json in a
// gate-side-only commit where a human sees it. That asymmetry is the ratchet.
//
// Runtime: the eslint pass is type-aware (no-floating-promises cannot work
// otherwise) and the tsc pass is a full program build. Together they take on the
// order of a minute. That is accepted — the alternative is a cheap gate that
// cannot see the defect class it exists to count.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const BASELINE_REL = 'lint-baseline.json';
const BASELINE = path.join(ROOT, BASELINE_REL);

const ESLINT_BIN = path.join(ROOT, 'node_modules', '.bin', 'eslint');
const TSC_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsc');

// The two commands, kept here as the single source of truth and echoed into
// lint-baseline.json so the stored numbers can always be reproduced by hand.
const ESLINT_ARGS = ['packages/server/src', '--no-inline-config', '-f', 'json'];
const TSC_ARGS = ['-p', 'tsconfig.lint.json', '--noEmit'];

// ── Measurement 1: eslint ──
// `--no-inline-config` is not optional. Without it a one-line
// `// eslint-disable-next-line no-empty` lowers the count without fixing
// anything, and a ratchet that a comment can turn is not a ratchet.
function measureEslint() {
  if (!fs.existsSync(ESLINT_BIN)) {
    console.error(`✗ eslint is not installed (${path.relative(ROOT, ESLINT_BIN)} missing). Run \`npm install\` at the repo root.`);
    process.exit(1);
  }
  const r = spawnSync(ESLINT_BIN, ESLINT_ARGS, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    console.error(`✗ could not run eslint: ${r.error.message}`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    console.error('✗ eslint did not produce parseable JSON. Raw output follows:');
    console.error((r.stdout || '').slice(0, 4000));
    console.error((r.stderr || '').slice(0, 4000));
    process.exit(1);
  }
  // A config whose `files` patterns stop matching lints nothing and reports a
  // beautiful zero. That is a broken gate, not a clean tree.
  if (report.length === 0) {
    console.error('✗ eslint linted ZERO files. The config scope is broken — a gate that reads nothing passes everything.');
    process.exit(1);
  }
  const counts = {};
  for (const file of report) {
    for (const m of file.messages) {
      // Parse/config failures arrive with no ruleId; they must never be silently
      // folded into a rule bucket or dropped.
      const key = m.ruleId ?? '(no rule id — parse or config failure)';
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return { counts, filesLinted: report.length };
}

// ── Measurement 2: unused symbols via tsc ──
// tsc exits non-zero whenever diagnostics exist, which is the normal case here,
// so the exit code is not the signal — the parsed diagnostic lines are.
function measureUnusedSymbols() {
  if (!fs.existsSync(TSC_BIN)) {
    console.error(`✗ typescript is not installed (${path.relative(ROOT, TSC_BIN)} missing). Run \`npm install\` at the repo root.`);
    process.exit(1);
  }
  const r = spawnSync(TSC_BIN, TSC_ARGS, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    console.error(`✗ could not run tsc: ${r.error.message}`);
    process.exit(1);
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const counts = {};
  for (const line of out.split('\n')) {
    const m = /error (TS\d+):/.exec(line);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return { counts };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) {
    console.error(`✗ ${BASELINE_REL} not found at the repo root. The lint baseline cannot run without it.`);
    process.exit(1);
  }
  let b;
  try {
    b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    console.error(`✗ ${BASELINE_REL} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  for (const section of ['eslint', 'unusedSymbols']) {
    const s = b?.[section];
    if (!s || typeof s.counts !== 'object' || Array.isArray(s.counts)) {
      console.error(`✗ ${BASELINE_REL}: section "${section}" must contain a "counts" object mapping rule/code → pinned count.`);
      process.exit(1);
    }
    for (const [k, v] of Object.entries(s.counts)) {
      if (!Number.isInteger(v) || v < 0) {
        console.error(`✗ ${BASELINE_REL}: "${section}.counts.${k}" has a non-integer pin (${JSON.stringify(v)}).`);
        process.exit(1);
      }
    }
  }
  if (!Array.isArray(b.typeAwareRules)) {
    console.error(`✗ ${BASELINE_REL} must contain a "typeAwareRules" array (may be empty) naming the rules that need type information.`);
    process.exit(1);
  }
  return b;
}

function sum(counts) {
  return Object.values(counts).reduce((a, n) => a + n, 0);
}

function writeBaseline(b) {
  // Totals are always derived from the pins so the file cannot drift internally.
  for (const section of ['eslint', 'unusedSymbols']) {
    const sorted = {};
    for (const k of Object.keys(b[section].counts).sort()) sorted[k] = b[section].counts[k];
    b[section].counts = sorted;
    b[section].total = sum(sorted);
  }
  b.grandTotal = b.eslint.total + b.unusedSymbols.total;
  fs.writeFileSync(BASELINE, JSON.stringify(b, null, 2) + '\n');
}

// ════════════════════════════════════════

const baseline = loadBaseline();
const tighten = process.argv.includes('--tighten');

const eslintRun = measureEslint();
const tscRun = measureUnusedSymbols();

const measured = {
  eslint: eslintRun.counts,
  unusedSymbols: tscRun.counts,
};

const LABEL = { eslint: 'eslint rule', unusedSymbols: 'TS diagnostic' };

// ── --tighten: lower pins to reality, never raise, never add ──
if (tighten) {
  const lowered = [];
  for (const section of ['eslint', 'unusedSymbols']) {
    for (const [key, pinned] of Object.entries(baseline[section].counts)) {
      const cur = measured[section][key] ?? 0;
      if (cur < pinned) {
        baseline[section].counts[key] = cur;
        lowered.push({ section, key, from: pinned, to: cur });
      }
      // cur > pinned is a RISE: left untouched on purpose. --tighten must never
      // become the way to launder a regression; the check below still fails it.
    }
  }
  if (lowered.length) {
    writeBaseline(baseline);
    console.log(`tightened ${lowered.length} entr${lowered.length === 1 ? 'y' : 'ies'}:`);
    for (const l of lowered.sort((a, b) => b.from - b.to - (a.from - a.to))) {
      console.log(`  ${LABEL[l.section]} ${l.key}: ${l.from} → ${l.to}  (−${l.from - l.to})`);
    }
  } else {
    console.log('nothing to tighten — every pinned count already equals or sits below what the tree measures.');
  }
  console.log('');
  // Fall through to the full check so --tighten can never report success over a rise.
}

// ── Rule 1: no pinned count may rise ──
const risen = [];
for (const section of ['eslint', 'unusedSymbols']) {
  for (const [key, pinned] of Object.entries(baseline[section].counts)) {
    const cur = measured[section][key] ?? 0;
    if (cur > pinned) risen.push({ section, key, pinned, cur });
  }
}

// ── Rule 2: a finding under an UNPINNED rule/code is a rise from zero ──
const unlisted = [];
for (const section of ['eslint', 'unusedSymbols']) {
  for (const [key, cur] of Object.entries(measured[section])) {
    if (cur > 0 && !Object.prototype.hasOwnProperty.call(baseline[section].counts, key)) {
      unlisted.push({ section, key, cur });
    }
  }
}

// ── Rule 3: the totals, compared independently of the per-rule pins ──
const totals = [];
for (const section of ['eslint', 'unusedSymbols']) {
  const cur = sum(measured[section]);
  const pinned = baseline[section].total;
  if (Number.isInteger(pinned) && cur > pinned) totals.push({ section, pinned, cur });
}
const grandCur = sum(measured.eslint) + sum(measured.unusedSymbols);

// ── Rule 4: a type-aware rule that silently reports zero is a broken config ──
// A misconfigured `parserOptions.project` does not error; it just stops finding
// anything. On a codebase this size, 0 floating promises is not an achievement,
// it is a symptom.
const suspiciousZero = [];
for (const rule of baseline.typeAwareRules) {
  const pinned = baseline.eslint.counts[rule];
  if (Number.isInteger(pinned) && pinned > 0 && (measured.eslint[rule] ?? 0) === 0) {
    suspiciousZero.push({ rule, pinned });
  }
}

// ── Report ──
let failed = false;

if (risen.length) {
  failed = true;
  console.error(`✗ ${risen.length} pinned count(s) ROSE above the baseline:`);
  for (const r of risen.sort((a, b) => b.cur - b.pinned - (a.cur - a.pinned))) {
    console.error(`  ${LABEL[r.section]} ${r.key}: baseline ${r.pinned}, now ${r.cur}  (+${r.cur - r.pinned})`);
  }
  console.error('  These counts may only fall. Fix the new findings, or fix as many old ones as you added.');
  console.error(`  Raising a pin is a deliberate hand edit to ${BASELINE_REL} in a gate-side-only commit.`);
  console.error('');
}

if (unlisted.length) {
  failed = true;
  console.error(`✗ ${unlisted.length} unpinned rule/code(s) reported findings (an unpinned count starts at zero):`);
  for (const u of unlisted.sort((a, b) => b.cur - a.cur)) {
    console.error(`  ${LABEL[u.section]} ${u.key}: ${u.cur}`);
  }
  console.error(`  If a rule was deliberately enabled, add it to ${BASELINE_REL} with its measured count in the`);
  console.error('  same gate-side commit — that addition is meant to be seen and argued with.');
  console.error('  If a NEW TS diagnostic code appeared, that is usually a real type error: run `npm run typecheck`.');
  console.error('');
}

if (totals.length) {
  failed = true;
  for (const t of totals) {
    console.error(`✗ ${t.section} TOTAL rose: baseline ${t.pinned}, now ${t.cur}  (+${t.cur - t.pinned})`);
  }
  console.error('');
}

if (suspiciousZero.length) {
  failed = true;
  console.error(`✗ ${suspiciousZero.length} type-aware rule(s) now report ZERO against a non-zero baseline:`);
  for (const s of suspiciousZero) console.error(`  ${s.rule}: baseline ${s.pinned}, now 0`);
  console.error('  Type-aware linting fails SILENTLY — a broken `parserOptions.project` reports nothing and looks clean.');
  console.error('  Check eslint.config.js and packages/server/tsconfig.json before believing this.');
  console.error(`  If the findings really were all fixed, accept it with --tighten (a gate-side edit to ${BASELINE_REL}).`);
  console.error('');
}

if (failed) {
  console.error('✗ lint baseline: refusing. These counts are decrease-only.');
  process.exit(1);
}

const eslintCur = sum(measured.eslint);
const unusedCur = sum(measured.unusedSymbols);
console.log(
  `✓ lint baseline clean — eslint ${eslintCur}/${baseline.eslint.total} across ${Object.keys(baseline.eslint.counts).length} pinned rule(s) ` +
    `over ${eslintRun.filesLinted} file(s); unused symbols ${unusedCur}/${baseline.unusedSymbols.total} across ` +
    `${Object.keys(baseline.unusedSymbols.counts).length} pinned code(s); grand total ${grandCur}/${baseline.grandTotal}`,
);
