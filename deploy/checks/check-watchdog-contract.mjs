#!/usr/bin/env node
// ════════════════════════════════════════
// Watchdog ↔ platform contract conformance (Phase 0 T5).
//
// The watchdog is a SEPARATE process on purpose: it has to keep working while
// the platform will not boot, which is exactly when it decides whether to roll
// the box back. That independence forbids it from importing platform code, so
// the update-state contract — the boot-attempt limit, the wall clock, the
// rollback cap, the phase names, the marker shape — is HAND-COPIED into both
// packages, with a comment as the only thing binding them.
//
// A comment is not a binding. If the copies drift, nothing fails, nothing warns,
// and the divergence surfaces during a failed self-update — the one moment the
// machinery exists for and the one moment nobody is watching. This checker is
// the binding.
//
// ── RULE 1: every declaration copy agrees, value for value and set for set ──
//   The copies are listed in COPIES below. For each one the checker extracts
//   FAIL_BOOT_ATTEMPTS, FAIL_WALL_CLOCK_MS, MAX_AUTO_ROLLBACKS, the UpdatePhase
//   union members, the runtime PHASES array, and the UpdateMarker field shape,
//   then compares them across copies. Any disagreement prints a diff table
//   naming the copies and exits 1. A copy that declares a member the others
//   lack is a mismatch too — a fact one side knows and the other does not is
//   the same defect as a number they disagree on.
//
//   packages/server/src/update-state.ts is AUTHORITATIVE. It is the writer; the
//   watchdog only reads what the platform wrote. When this gate fires, the
//   watchdog copy moves to match the platform, never the reverse.
//
// ── RULE 2: no new declaration copy appears unannounced ──
//   Rule 1 can only compare copies it knows about. A THIRD file that starts
//   declaring FAIL_BOOT_ATTEMPTS is invisible to it — which is precisely how a
//   two-copy contract quietly becomes a three-copy one. So the checker also
//   SCANS the source tree for declarations and fails on any it was not told
//   about. Adding the file to COPIES costs one line and is meant to be seen.
//   (Same asymmetry as the ratchet's new-file cap: the compare rule cannot see
//   a brand-new copy; this does.)
//
// ── RULE 3: the watchdog imports nothing from the platform ──
//   The whole reason the contract is hand-copied is that watchdog/src must not
//   depend on packages/server or @dojo/shared. If an import ever crosses that
//   line, the duplication stops being justified AND the watchdog stops being
//   able to boot without the platform. Checked in both directions a dependency
//   can enter: import/require/dynamic-import specifiers in watchdog/src/**, and
//   the dependency lists in watchdog/package.json.
//
// ════════════════════════════════════════
// WHY THIS MATCHES IN NODE INSTEAD OF SHELLING OUT TO grep
// ════════════════════════════════════════
// `grep` on the box this was written on is ugrep 7.5.0 behind a shim that
// honours .gitignore (DOJO-ISSUES-LOG.md §environment, 2026-07-27). A gate whose
// verdict depends on which grep is installed is not a gate. Everything here
// reads files and matches in JS; the reproducing grep command is PRINTED for a
// human to re-run, never depended on.
//
// ════════════════════════════════════════
// HOW THE EXTRACTION WORKS, AND WHERE IT IS DUMB
// ════════════════════════════════════════
// Comments are stripped first (`//` only counts as a comment when an even number
// of quote characters precedes it on the line, so a URL inside a string
// survives; block comments go unconditionally). Then, per copy:
//
//   • `const NAME = <expr>` — the expression is normalised: `_` separators are
//     dropped and a pure-arithmetic expression is evaluated, so `15 * 60_000`
//     and `900000` compare EQUAL. That is the right answer for a contract check:
//     the two sides agree on the value even when they spell it differently.
//     A non-arithmetic expression is compared as normalised text.
//   • `type UpdatePhase = | 'a' | 'b' …` — every quoted member of the union.
//   • `const PHASES: readonly UpdatePhase[] = [ … ]` — the RUNTIME list, which
//     both copies also carry. It is compared across copies AND against that same
//     file's union, because a file whose runtime list disagrees with its own
//     type has a bug the type checker cannot see (the list is what `readMarker`
//     validates against at runtime; the type is erased).
//   • `interface UpdateMarker { … }` — field names and their normalised type
//     text. The file headers on both copies call this a "byte-for-byte-
//     compatible copy of this shape"; this is that claim, checked.
//
// Known blind spots, stated rather than hidden: a copy that declares the
// contract through indirection (computed constant, re-export, spread) is not
// seen by the declaration regexes and would be missed by BOTH rule 1 and rule 2.
// The contract is deliberately written as flat literals in both copies today,
// and rule 2's scan is what notices if a new copy shows up in a readable form.
//
// ════════════════════════════════════════
// BITE-PROOF
// ════════════════════════════════════════
//   WATCHDOG_CONTRACT_EXTRA=/path/to/scratch.ts node deploy/checks/check-watchdog-contract.mjs
// adds one more file to the comparison set (comma-separate for several). It
// exists so this gate can be proven to bite — point it at a scratch copy with
// one value changed and watch the diff table name it — WITHOUT planting a
// deliberately-wrong file in the product tree, which is how a bite-proof turns
// into a shipped defect. It only ever ADDS a copy; it can never remove one or
// relax a rule.
//
// Usage:
//   node deploy/checks/check-watchdog-contract.mjs     # exit 0 clean, 1 on any violation
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// ── The declaration copies (Phase 0 T5 Step 1, measured 2026-07-27) ──
// Authoritative side FIRST: the platform owns the marker, the watchdog mirrors it.
const COPIES = [
  'packages/server/src/update-state.ts',
  'watchdog/src/auto-rollback.ts',
];

// The contract members this gate governs, by name.
const CONST_MEMBERS = ['FAIL_BOOT_ATTEMPTS', 'FAIL_WALL_CLOCK_MS', 'MAX_AUTO_ROLLBACKS'];
const UNION_TYPE = 'UpdatePhase';
const RUNTIME_LIST = 'PHASES';
const SHAPE_INTERFACE = 'UpdateMarker';

// Rule 2 scan scope: the packages a copy could plausibly appear in.
const SCAN_DIRS = ['watchdog/src', 'packages/server/src', 'packages/shared/src'];
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const TEST_PATH = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[tj]sx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

// The watchdog's independence boundary: nothing on this side of it may be
// imported by watchdog/src.
const FORBIDDEN_SPECIFIER = /^@dojo\/|(?:^|\/)packages\/(?:server|shared|dashboard)(?:\/|$)/;

// ── file walking ──

function walk(absDir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, out);
    } else if (SOURCE_EXT.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
}

// ── comment stripping ──
// Block comments go unconditionally. A `//` only opens a line comment when an
// even number of quote characters precedes it on that line, so `https://…`
// inside a string literal survives. (Same heuristic as check-orphans.mjs.)
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks
    .split('\n')
    .map((line) => {
      let quotes = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" || ch === '"' || ch === '`') quotes++;
        else if (ch === '/' && line[i + 1] === '/' && quotes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

// ── value normalisation ──
// `15 * 60_000` and `900000` are the same value; a contract check that called
// them different would be reporting on spelling, not on the contract.
function normaliseValue(raw) {
  const text = raw.trim().replace(/;+$/, '').trim();
  const noSep = text.replace(/_/g, '');
  if (/^[0-9+\-*/().\s]+$/.test(noSep) && /[0-9]/.test(noSep)) {
    try {
      // eslint-disable-next-line no-new-func
      const v = Function(`"use strict"; return (${noSep});`)();
      if (typeof v === 'number' && Number.isFinite(v)) {
        return { text: String(v), source: text };
      }
    } catch {
      /* fall through to text comparison */
    }
  }
  return { text: text.replace(/\s+/g, ' '), source: text };
}

// ── extraction ──

function extractConst(code, name) {
  const re = new RegExp(`(?:^|[\\s;}])(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`);
  const m = re.exec(code);
  if (!m) return null;
  return normaliseValue(m[1]);
}

function extractUnionMembers(code, typeName) {
  const re = new RegExp(`(?:^|[\\s;}])(?:export\\s+)?type\\s+${typeName}\\s*=\\s*([^;]+);`);
  const m = re.exec(code);
  if (!m) return null;
  const members = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  return members.length ? members : null;
}

function extractArrayMembers(code, name) {
  const re = new RegExp(`(?:^|[\\s;}])(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`);
  const m = re.exec(code);
  if (!m) return null;
  const members = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
  return members.length ? members : null;
}

function extractInterfaceFields(code, name) {
  const re = new RegExp(`(?:^|[\\s;}])(?:export\\s+)?interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(code);
  if (!m) return null;
  const fields = new Map();
  for (const line of m[1].split('\n')) {
    const f = /^\s*([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*(.+?)\s*;?\s*$/.exec(line);
    if (f) fields.set(f[1] + f[2], f[3].replace(/\s+/g, ' ').replace(/;+$/, ''));
  }
  return fields.size ? fields : null;
}

// A copy's contract, flattened to comparable `fact -> value` pairs so one diff
// table can carry constants, union membership and shape in the same shape.
function readCopy(rel, absOverride) {
  const abs = absOverride ?? path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { rel, abs, missing: true, facts: new Map() };
  const code = stripComments(fs.readFileSync(abs, 'utf8'));
  const facts = new Map();
  const raw = {};

  for (const name of CONST_MEMBERS) {
    const v = extractConst(code, name);
    raw[name] = v;
    if (v) facts.set(`const ${name}`, v.text);
  }

  const union = extractUnionMembers(code, UNION_TYPE);
  raw.union = union;
  if (union) for (const m of union) facts.set(`${UNION_TYPE} member '${m}'`, 'declared');

  const runtime = extractArrayMembers(code, RUNTIME_LIST);
  raw.runtime = runtime;
  if (runtime) for (const m of runtime) facts.set(`${RUNTIME_LIST}[] entry '${m}'`, 'listed');

  const fields = extractInterfaceFields(code, SHAPE_INTERFACE);
  raw.fields = fields;
  if (fields) for (const [f, t] of fields) facts.set(`${SHAPE_INTERFACE}.${f}`, t);

  return { rel, abs, missing: false, facts, raw, code };
}

// ── copy set ──

const extraRaw = (process.env.WATCHDOG_CONTRACT_EXTRA ?? '').trim();
const extras = extraRaw ? extraRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

const copies = COPIES.map((rel) => readCopy(rel));
for (const e of extras) {
  const abs = path.isAbsolute(e) ? e : path.resolve(ROOT, e);
  copies.push({ ...readCopy(path.relative(ROOT, abs), abs), extra: true });
}

let failed = false;

// ── RULE 1: the copies agree ──

const gone = copies.filter((c) => c.missing);
if (gone.length) {
  failed = true;
  console.error(`✗ ${gone.length} declared contract copy/copies do not exist:`);
  for (const g of gone) console.error(`  ${g.rel}${g.extra ? '  (from WATCHDOG_CONTRACT_EXTRA)' : ''}`);
  console.error('  If a copy was deliberately deleted, remove it from COPIES in this checker');
  console.error('  in the same commit, so the copy list keeps describing the tree.');
  console.error('');
}

const live = copies.filter((c) => !c.missing);

// Every member the plan names must actually be found in every live copy —
// otherwise a silently-failing regex would read as "the copies agree".
for (const c of live) {
  const absent = [];
  for (const name of CONST_MEMBERS) if (!c.raw[name]) absent.push(`const ${name}`);
  if (!c.raw.union) absent.push(`type ${UNION_TYPE}`);
  if (absent.length) {
    failed = true;
    console.error(`✗ ${c.rel}: contract member(s) not found by extraction: ${absent.join(', ')}`);
    console.error('  Either this copy stopped declaring them (a real contract change that must be');
    console.error('  made on every copy), or it declares them in a form this checker cannot read.');
    console.error('  Both cases need a human; a gate that cannot see a member must never pass it.');
    console.error('');
  }
}

// Per-file self-consistency: the runtime list is what readMarker validates
// against; the union type is erased at runtime. A file that disagrees with
// itself has a bug no type checker can catch.
for (const c of live) {
  if (!c.raw.union || !c.raw.runtime) continue;
  const u = [...c.raw.union].sort().join(',');
  const r = [...c.raw.runtime].sort().join(',');
  if (u !== r) {
    failed = true;
    console.error(`✗ ${c.rel}: its runtime ${RUNTIME_LIST}[] disagrees with its own ${UNION_TYPE} union`);
    console.error(`    ${UNION_TYPE}: ${c.raw.union.join(', ')}`);
    console.error(`    ${RUNTIME_LIST}[]: ${c.raw.runtime.join(', ')}`);
    console.error(`  ${RUNTIME_LIST}[] is what readMarker validates against at runtime; the union is erased.`);
    console.error('');
  }
}

// The comparison itself: union of every fact any copy declares, checked across all.
const allFacts = [...new Set(live.flatMap((c) => [...c.facts.keys()]))];
const mismatched = allFacts.filter((f) => {
  const seen = live.map((c) => c.facts.get(f) ?? '—');
  return new Set(seen).size > 1;
});

if (live.length > 1 && mismatched.length) {
  failed = true;
  console.error(`✗ watchdog/platform contract DRIFT — ${mismatched.length} fact(s) disagree across ${live.length} declaration copies:`);
  console.error('');
  const labels = live.map((_, i) => `[${i + 1}]`);
  for (let i = 0; i < live.length; i++) {
    console.error(`  ${labels[i]} ${live[i].rel}${live[i].extra ? '  (WATCHDOG_CONTRACT_EXTRA)' : ''}${i === 0 ? '   ← AUTHORITATIVE' : ''}`);
  }
  console.error('');
  const nameW = Math.max(4, ...mismatched.map((f) => f.length));
  const cells = mismatched.map((f) => live.map((c) => c.facts.get(f) ?? '— (not declared)'));
  const colW = labels.map((l, i) => Math.max(l.length, ...cells.map((row) => row[i].length)));
  console.error(`  ${'fact'.padEnd(nameW)}  ${labels.map((l, i) => l.padEnd(colW[i])).join('  ')}`);
  console.error(`  ${'-'.repeat(nameW)}  ${colW.map((w) => '-'.repeat(w)).join('  ')}`);
  mismatched.forEach((f, r) => {
    console.error(`  ${f.padEnd(nameW)}  ${cells[r].map((v, i) => v.padEnd(colW[i])).join('  ')}`);
  });
  console.error('');
  console.error('  The watchdog cannot import the platform (it must run while the platform will not');
  console.error('  boot), so these copies are hand-synced and nothing but this gate binds them.');
  console.error(`  FIX DIRECTION: ${live[0].rel} is authoritative — it is the writer. Move the other`);
  console.error('  copy/copies to match it. Drift here is a live incident: log it in DOJO-ISSUES-LOG.md.');
  console.error('');
}

// ── RULE 2: no undeclared declaration copy ──

const declaredAbs = new Set(copies.map((c) => c.abs));
const undeclared = [];
const testDeclarations = [];

for (const dir of SCAN_DIRS) {
  for (const abs of walk(path.join(ROOT, dir))) {
    if (declaredAbs.has(abs)) continue;
    let code;
    try {
      code = stripComments(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    const declares = [];
    for (const name of CONST_MEMBERS) if (extractConst(code, name)) declares.push(`const ${name}`);
    if (extractUnionMembers(code, UNION_TYPE)) declares.push(`type ${UNION_TYPE}`);
    if (!declares.length) continue;
    const rel = path.relative(ROOT, abs);
    // Tests are PRINTED, never failed on: a test that pins the contract is
    // evidence the contract is load-bearing, not a rogue copy.
    if (TEST_PATH.test(rel)) testDeclarations.push({ rel, declares });
    else undeclared.push({ rel, declares });
  }
}

if (undeclared.length) {
  failed = true;
  console.error(`✗ ${undeclared.length} UNDECLARED contract declaration copy/copies found:`);
  for (const u of undeclared) console.error(`  ${u.rel}  declares: ${u.declares.join(', ')}`);
  console.error('  A third copy of a hand-synced contract is how a two-way drift becomes a three-way one,');
  console.error('  and rule 1 can only compare copies it was told about. Either import the value from an');
  console.error('  existing copy, or add this file to COPIES in this checker so it is compared too.');
  console.error('');
}

// ── RULE 3: the watchdog imports nothing from the platform ──

const SPEC_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const WATCHDOG_SRC = path.join(ROOT, 'watchdog', 'src');
const WATCHDOG_PKG = path.join(ROOT, 'watchdog');
const crossings = [];
let watchdogFilesScanned = 0;

for (const abs of walk(WATCHDOG_SRC)) {
  watchdogFilesScanned++;
  const code = stripComments(fs.readFileSync(abs, 'utf8'));
  const rel = path.relative(ROOT, abs);
  const specs = new Set();
  for (const re of SPEC_PATTERNS) for (const m of code.matchAll(re)) specs.add(m[1]);
  for (const spec of specs) {
    if (FORBIDDEN_SPECIFIER.test(spec)) {
      crossings.push({ rel, spec, why: 'names a platform package' });
      continue;
    }
    if (spec.startsWith('.')) {
      const resolved = path.resolve(path.dirname(abs), spec);
      if (!resolved.startsWith(WATCHDOG_PKG + path.sep)) {
        crossings.push({ rel, spec, why: `resolves outside watchdog/ → ${path.relative(ROOT, resolved)}` });
      }
    }
  }
}

// The second door: a declared dependency is a coupling even before any file
// imports it.
const wdPkgPath = path.join(WATCHDOG_PKG, 'package.json');
if (fs.existsSync(wdPkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(wdPkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_SPECIFIER.test(dep)) {
        crossings.push({ rel: 'watchdog/package.json', spec: dep, why: `declared in ${field}` });
      }
    }
  }
}

if (crossings.length) {
  failed = true;
  console.error(`✗ ${crossings.length} import(s) cross the watchdog's independence boundary:`);
  for (const c of crossings) console.error(`  ${c.rel}  →  ${c.spec}   (${c.why})`);
  console.error('  The watchdog must run when the platform will not boot; a platform import means it');
  console.error('  cannot. That independence is the ONLY reason the contract above is hand-copied —');
  console.error('  if the import is genuinely wanted, the duplication should be deleted instead.');
  console.error('');
}

// ── verdict ──

if (failed) {
  console.error('✗ watchdog contract: refusing.');
  console.error('  Reproduce the copy search by hand with:');
  console.error(`    grep -ra "${CONST_MEMBERS.join('\\|')}\\|${UNION_TYPE}" watchdog/ packages/server/src/ --include='*.ts' -l`);
  process.exit(1);
}

const phases = live[0]?.raw?.union ?? [];
const consts = CONST_MEMBERS.map((n) => `${n}=${live[0]?.facts.get(`const ${n}`)}`).join(', ');
console.log(
  `✓ watchdog contract conformant — ${live.length} declaration copies agree on ${allFacts.length} facts` +
    `${extras.length ? ` (incl. ${extras.length} via WATCHDOG_CONTRACT_EXTRA)` : ''}`,
);
for (const c of live) console.log(`    ${c.rel}${c.extra ? '  (WATCHDOG_CONTRACT_EXTRA)' : ''}`);
console.log(`  ${consts}; ${UNION_TYPE} = ${phases.map((p) => `'${p}'`).join(' | ')}`);
console.log(
  `  no undeclared copy in ${SCAN_DIRS.join(', ')}` +
    `${testDeclarations.length ? ` (${testDeclarations.length} test declaration(s) seen, not compared: ${testDeclarations.map((t) => t.rel).join(', ')})` : ''}`,
);
console.log(`  watchdog independence intact — ${watchdogFilesScanned} file(s) in watchdog/src import nothing from packages/server, packages/shared or @dojo/*`);
