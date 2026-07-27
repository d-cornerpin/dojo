#!/usr/bin/env node
// ════════════════════════════════════════
// Size-ratchet gate (Phase 0 T2).
//
// The overhaul exists to shrink this codebase. Two rules, both machine-checked,
// because "we'll clean it up later" is where the last two years went:
//
//   1. DECREASE-ONLY. Every path in ratchets.json carries a pinned line count.
//      The file may shrink; it may never exceed its pin. A pinned file that
//      DISAPPEARED also fails — deletion is progress, but the manifest must be
//      updated in the same commit, or it rots into a list of lies.
//
//   2. NEW-FILE CAP. Any tracked source file NOT in the manifest that exceeds
//      `maxNewFileLines` fails. The decrease-only rule cannot see a brand-new
//      god file; this does. The fix is to add it to ratchets.json, and that
//      addition being visible and reviewable IS the point.
//
// Lines are counted as newline bytes — exactly what `wc -l` reports — so any
// number this tool prints can be reproduced by hand with `wc -l <file>`.
//
// Usage:
//   node deploy/checks/check-ratchets.mjs             # check; exit 1 on any violation
//   node deploy/checks/check-ratchets.mjs --tighten   # lower pins to reality, then check
//
// --tighten only ever LOWERS. Nothing in this tool raises a pin or adds an
// entry: raising a ceiling, or admitting a new file above the cap, is a
// deliberate hand edit to ratchets.json in a gate-side-only commit, where a
// human sees it. That asymmetry is the ratchet.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Scan scope for rule 2. Product source only: the manifest is about shipped
// code, so tests, fixtures and generated migrations are out.
const IN_SCOPE = /^(?:packages\/[^/]+\/src\/|watchdog\/src\/).*\.(?:ts|tsx)$/;
const EXCLUDED = [/(?:^|\/)__tests__\//, /\.(?:test|spec)\.tsx?$/, /(?:^|\/)db\/migrations\//];

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const MANIFEST_REL = 'ratchets.json';
const MANIFEST = path.join(ROOT, MANIFEST_REL);

// `wc -l` semantics: count 0x0A bytes. A file whose last line has no trailing
// newline therefore counts one lower — same as wc, which is the whole point.
function lineCount(abs) {
  const buf = fs.readFileSync(abs);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n;
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`✗ ${MANIFEST_REL} not found at the repo root. The size ratchet cannot run without it.`);
    process.exit(1);
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    console.error(`✗ ${MANIFEST_REL} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!m || typeof m.files !== 'object' || Array.isArray(m.files)) {
    console.error(`✗ ${MANIFEST_REL} must contain a "files" object mapping path → pinned line count.`);
    process.exit(1);
  }
  if (!Number.isInteger(m.maxNewFileLines) || m.maxNewFileLines <= 0) {
    console.error(`✗ ${MANIFEST_REL} must contain a positive integer "maxNewFileLines".`);
    process.exit(1);
  }
  for (const [rel, pinned] of Object.entries(m.files)) {
    if (!Number.isInteger(pinned) || pinned < 0) {
      console.error(`✗ ${MANIFEST_REL}: entry "${rel}" has a non-integer pin (${JSON.stringify(pinned)}).`);
      process.exit(1);
    }
  }
  return m;
}

function writeManifest(m) {
  const files = {};
  for (const k of Object.keys(m.files).sort()) files[k] = m.files[k];
  const out = { ...m, files };
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n');
}

function trackedInScope() {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => IN_SCOPE.test(rel) && !EXCLUDED.some((r) => r.test(rel)));
}

const manifest = loadManifest();
const tighten = process.argv.includes('--tighten');

// ── --tighten: lower pins to reality, never raise ──
if (tighten) {
  const lowered = [];
  for (const [rel, pinned] of Object.entries(manifest.files)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // a missing file is a FAIL below, not a silent edit
    const cur = lineCount(abs);
    if (cur < pinned) {
      manifest.files[rel] = cur;
      lowered.push({ rel, from: pinned, to: cur });
    }
    // cur > pinned is a growth: left untouched on purpose. --tighten must never
    // be a way to launder a file that grew; the check below still fails it.
  }
  if (lowered.length) {
    writeManifest(manifest);
    console.log(`tightened ${lowered.length} entr${lowered.length === 1 ? 'y' : 'ies'}:`);
    for (const l of lowered.sort((a, b) => b.from - b.to - (a.from - a.to))) {
      console.log(`  ${l.rel}: ${l.from} → ${l.to}  (−${l.from - l.to})`);
    }
  } else {
    console.log('nothing to tighten — every pin already equals or sits below the current count.');
  }
  console.log('');
  // Fall through to the full check so --tighten can never report success over a violation.
}

// ── Rule 1: pinned files may only shrink ──
const grew = [];
const missing = [];
for (const [rel, pinned] of Object.entries(manifest.files)) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    missing.push({ rel, pinned });
    continue;
  }
  const cur = lineCount(abs);
  if (cur > pinned) grew.push({ rel, pinned, cur });
}

// ── Rule 2: an unlisted source file may not exceed the cap ──
const CAP = manifest.maxNewFileLines;
const oversized = [];
for (const rel of trackedInScope()) {
  if (Object.prototype.hasOwnProperty.call(manifest.files, rel)) continue;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue; // tracked but deleted in the working tree
  const cur = lineCount(abs);
  if (cur > CAP) oversized.push({ rel, cur });
}

// ── Report ──
let failed = false;

if (grew.length) {
  failed = true;
  console.error(`✗ ${grew.length} file(s) GREW past their ratchet (line counts are \`wc -l\`):`);
  for (const g of grew.sort((a, b) => b.cur - b.pinned - (a.cur - a.pinned))) {
    console.error(`  ${g.rel}: pinned ${g.pinned}, now ${g.cur}  (+${g.cur - g.pinned})`);
  }
  console.error('  These files may only shrink. Move the new code elsewhere, or delete as much as you add.');
  console.error(`  A deliberate ceiling raise is a hand edit to ${MANIFEST_REL} in a gate-side-only commit.`);
  console.error('');
}

if (missing.length) {
  failed = true;
  console.error(`✗ ${missing.length} pinned file(s) no longer exist:`);
  for (const m of missing) console.error(`  ${m.rel} (pinned ${m.pinned})`);
  console.error(`  Deleting the file is progress — now remove its entry from ${MANIFEST_REL} in the same commit,`);
  console.error('  so the manifest keeps describing the tree instead of rotting into a list of lies.');
  console.error('');
}

if (oversized.length) {
  failed = true;
  console.error(`✗ ${oversized.length} unlisted source file(s) exceed the ${CAP}-line new-file cap:`);
  for (const o of oversized.sort((a, b) => b.cur - a.cur)) {
    console.error(`  ${o.rel}: ${o.cur} lines`);
  }
  console.error(`  Split it, or add it to ${MANIFEST_REL} with its current count in the same commit —`);
  console.error('  that addition is meant to be seen and argued with. That is the point of the cap.');
  console.error('');
}

if (failed) {
  console.error('✗ size ratchets: refusing. Files may only shrink; new files may not balloon.');
  process.exit(1);
}

const entries = Object.keys(manifest.files).length;
const scanned = trackedInScope().length;
console.log(`✓ size ratchets clean — ${entries} pinned file(s) at or below their pin; ${scanned} source file(s) scanned, none unlisted above ${CAP} lines`);
