#!/usr/bin/env node
// ════════════════════════════════════════
// Growth detector (Phase 0 T12d Step 3b). THIS ONE CAN FAIL A BUILD.
//
// The size ratchet (T2) is decrease-only over a manifest of 105 pinned files,
// plus a 400-line cap on anything unpinned. Between those two rules is a gap
// you can drive a rebuild through: a file at 120 lines can become 380 without
// touching either rule, and a brand-new 300-line module lands clean. Research
// 19 §2.6 recommended closing it and it was never adopted until this pass.
//
// TWO RULES, both about MOVEMENT:
//
//   1. GROWTH.   A file more than 25% above its recorded baseline FAILS.
//   2. CROSSING. An UNPINNED file that was at or below 60% of the new-file cap
//                (240 of 400) — or did not exist — and is now above it FAILS.
//                Pinned files are exempt: the ratchet already governs them.
//
// ════ WHY A BASELINE FILE AND NOT A ROLLING CALENDAR WINDOW ════
// Measured 2026-07-27 before this was written: over the previous 30 days of
// history, 51 files had grown more than 25% and 22 had crossed 240 lines. Most
// of that is the upstream project's own development, inherited with the clone —
// not this rebuild's work. A bare calendar rule would have shipped a gate that
// was RED on arrival and re-fired on the same history forever, which is exactly
// the mistake T2 recorded avoiding when its manifest came out at 104 entries
// instead of the planned 15.
//
// So growth is measured from a RECORDED baseline, the same shape as
// `ratchets.json` and `lint-baseline.json`: seeded once, green on arrival,
// biting only on movement after it. `--record` refreshes it, and refreshing it
// is a deliberate, reviewable, gate-side-only commit — that asymmetry is the
// point, exactly as it is for the ratchet.
//
// The plan's "in 30 days" survives as the baseline's shelf life: the check
// prints the baseline's age and WARNS once it is older than `windowDays`, so a
// stale baseline nags instead of quietly widening the tolerance.
//
// ════ THE ESCAPE VALVE ════
// A file that must legitimately grow past a rule gets an entry in
// `ratchets.json` at its measured count — which makes it decrease-only from
// then on. Visible, argued, and in its own gate-side commit.
//
// Usage:
//   node deploy/checks/check-growth.mjs            # check; exit 1 on any violation
//   node deploy/checks/check-growth.mjs --record   # re-record the baseline, then check
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const RECORD = process.argv.includes('--record');
const VERBOSE = process.argv.includes('--verbose');

const BASELINE_REL = 'deploy/checks/growth-baseline.json';
const BASELINE = path.join(ROOT, BASELINE_REL);
const RATCHETS_REL = 'ratchets.json';
const RATCHETS = path.join(ROOT, RATCHETS_REL);

const GROWTH_LIMIT = 0.25;   // >25% above baseline fails
const CAP_FRACTION = 0.6;    // crossing 60% of the new-file cap fails
const WINDOW_DAYS = 30;      // the baseline's shelf life

const IN_SCOPE = /^(?:packages\/[^/]+\/src\/|watchdog\/src\/).*\.(?:ts|tsx)$/;
const EXCLUDED = [/(?:^|\/)__tests__\//, /\.(?:test|spec)\.tsx?$/, /(?:^|\/)db\/migrations\//];

// `wc -l` semantics, identical to check-ratchets.mjs so the two agree.
function lineCount(abs) {
  const buf = fs.readFileSync(abs);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

function trackedInScope() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => IN_SCOPE.test(rel) && !EXCLUDED.some((r) => r.test(rel)));
}

// ── The ratchet manifest supplies the cap and the pinned set ──
if (!fs.existsSync(RATCHETS)) {
  console.error(`✗ ${RATCHETS_REL} not found. The growth detector reads the new-file cap and the pinned`);
  console.error('  set from it, and refuses to invent either.');
  process.exit(1);
}
const ratchets = JSON.parse(fs.readFileSync(RATCHETS, 'utf8'));
const CAP = ratchets.maxNewFileLines;
const THRESHOLD = Math.floor(CAP * CAP_FRACTION);
const pinned = new Set(Object.keys(ratchets.files ?? {}));

const files = trackedInScope();
const current = new Map(files.map((rel) => [rel, lineCount(path.join(ROOT, rel))]));

// ── --record ──
function writeBaseline() {
  const out = {
    _comment: [
      'Growth baseline for deploy/checks/check-growth.mjs. Refreshed with --record,',
      'in a gate-side-only commit, deliberately. A file more than 25% above its entry',
      'here fails; an unpinned file that was at or below 60% of ratchets.json',
      'maxNewFileLines and is now above it fails. Re-record roughly every 30 days.',
    ],
    recordedAt: new Date().toISOString().slice(0, 10),
    recordedAtCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    windowDays: WINDOW_DAYS,
    growthLimit: GROWTH_LIMIT,
    capFraction: CAP_FRACTION,
    files: Object.fromEntries([...current.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
  return out;
}

if (RECORD) {
  const prevExisted = fs.existsSync(BASELINE);
  const prev = prevExisted ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const written = writeBaseline();
  console.log(`recorded ${Object.keys(written.files).length} file(s) at ${written.recordedAtCommit} (${written.recordedAt})`);
  if (prev) {
    const moved = [...current.entries()].filter(([r, n]) => prev.files?.[r] !== undefined && prev.files[r] !== n);
    const added = [...current.keys()].filter((r) => prev.files?.[r] === undefined);
    const gone = Object.keys(prev.files ?? {}).filter((r) => !current.has(r));
    console.log(`  ${moved.length} changed, ${added.length} new, ${gone.length} gone since ${prev.recordedAt}`);
  }
  console.log('');
  // Fall through to the check, so --record can never report success over a violation.
}

// ── Load the baseline ──
if (!fs.existsSync(BASELINE)) {
  console.error(`✗ ${BASELINE_REL} not found. The growth detector has nothing to measure movement from.`);
  console.error('  Seed it once, in a gate-side-only commit:');
  console.error('     node deploy/checks/check-growth.mjs --record');
  console.error('  Refusing rather than passing: with no baseline, every file would read as unchanged,');
  console.error('  which is the false green this check exists to prevent.');
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const base = baseline.files ?? {};

// ── Rule 1: more than 25% above the recorded baseline ──
const grew = [];
for (const [rel, cur] of current) {
  const was = base[rel];
  if (was === undefined || was <= 0) continue; // new files are rule 2's business
  const ratio = (cur - was) / was;
  if (ratio > GROWTH_LIMIT) grew.push({ rel, was, cur, pct: ratio * 100 });
}

// ── Rule 2: an unpinned file crossing 60% of the new-file cap ──
const crossed = [];
for (const [rel, cur] of current) {
  if (pinned.has(rel)) continue;             // the ratchet already governs these
  if (cur <= THRESHOLD) continue;
  const was = base[rel];
  const wasUnder = was === undefined || was <= THRESHOLD;
  if (wasUnder) crossed.push({ rel, was: was === undefined ? null : was, cur });
}

// ── Report ──
const ageDays = baseline.recordedAt
  ? Math.floor((Date.now() - Date.parse(`${baseline.recordedAt}T00:00:00Z`)) / 86_400_000)
  : null;

let failed = false;

if (grew.length) {
  failed = true;
  console.error(`✗ ${grew.length} file(s) grew more than ${Math.round(GROWTH_LIMIT * 100)}% above the recorded baseline:`);
  for (const g of grew.sort((a, b) => b.pct - a.pct)) {
    console.error(`  ${g.rel}: ${g.was} → ${g.cur} lines  (+${g.cur - g.was}, +${g.pct.toFixed(1)}%)`);
  }
  console.error('  The decrease-only ratchet cannot see this: none of these crossed a pin or the cap.');
  console.error(`  Delete as much as you add, split the file, or — if the growth is real and argued —`);
  console.error(`  re-record the baseline with \`--record\` in a gate-side-only commit that says why.`);
  console.error('');
}

if (crossed.length) {
  failed = true;
  console.error(`✗ ${crossed.length} unlisted file(s) crossed ${Math.round(CAP_FRACTION * 100)}% of the ${CAP}-line new-file cap (${THRESHOLD} lines):`);
  for (const c of crossed.sort((a, b) => b.cur - a.cur)) {
    console.error(`  ${c.rel}: ${c.was === null ? 'new since the baseline' : `${c.was} →`} ${c.cur} lines`);
  }
  console.error(`  A file this size is on its way to being a god file and the ${CAP}-line cap will not`);
  console.error(`  say so until it is too late to argue cheaply. Split it, or add it to ${RATCHETS_REL}`);
  console.error('  at its current count — which pins it decrease-only from then on, and makes the');
  console.error('  decision visible in a gate-side-only commit. That visibility IS the mechanism.');
  console.error('');
}

if (failed) {
  console.error(`✗ growth detector: refusing. Baseline ${BASELINE_REL} recorded ${baseline.recordedAt} at ${baseline.recordedAtCommit ?? '?'}.`);
  console.error('  Reproduce any count by hand:  wc -l <file>');
  process.exit(1);
}

console.log(
  `✓ growth clean — ${current.size} source file(s) measured against ${Object.keys(base).length} baseline entr(ies); `
  + `none above +${Math.round(GROWTH_LIMIT * 100)}%, none unlisted crossing ${THRESHOLD} of ${CAP} lines`,
);
console.log(`  baseline ${BASELINE_REL}: recorded ${baseline.recordedAt} at ${baseline.recordedAtCommit ?? '?'}${ageDays === null ? '' : `, ${ageDays} day(s) ago`}`);
if (ageDays !== null && ageDays > (baseline.windowDays ?? WINDOW_DAYS)) {
  console.log(`  ! the baseline is older than its ${baseline.windowDays ?? WINDOW_DAYS}-day shelf life — growth since then is measured against a stale`);
  console.log('    picture, which widens the tolerance quietly. Re-record it in a gate-side-only commit.');
}
if (VERBOSE) {
  const near = [...current.entries()]
    .filter(([rel, cur]) => !pinned.has(rel) && cur > THRESHOLD * 0.9 && cur <= THRESHOLD)
    .sort((a, b) => b[1] - a[1]);
  if (near.length) {
    console.log(`  ${near.length} unlisted file(s) within 10% of the ${THRESHOLD}-line crossing:`);
    for (const [rel, cur] of near) console.log(`     ${cur}  ${rel}`);
  }
}
process.exit(0);
