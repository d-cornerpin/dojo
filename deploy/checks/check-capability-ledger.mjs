#!/usr/bin/env node
// ════════════════════════════════════════
// Capability ledger (Phase 0 T12d Step 4). REPORTS by default; can be made to
// refuse with CAPABILITY_GATE=block (the same switch shape as the orphan gate).
//
// Every other gate in this directory watches for something BAD arriving. This
// one watches for something GOOD leaving. An overhaul that consolidates five
// half-built systems into one will, at some point, quietly fail to carry a tool
// across — and no behavioural diff can see that, because the tests that would
// have exercised it went with it. OMISSION is invisible to everything except a
// list made before the work started.
//
// So: five inventories, extracted mechanically from the tree, compared against
// a committed CSV. A capability the CSV records as `built` and the tree no
// longer has is the finding this exists for.
//
// ════ THE STATUS COLUMN HAS EXACTLY THREE STATES ════
//   built              — it is in the tree now.
//   dropped(OWNER-OK)  — it is gone, and the owner agreed it should be.
//   pending            — planned, not built yet.
// There is deliberately NO `partial` (research 19:71). "Partial" is how five
// tracking systems came to exist: a thing half-carried across reads as done in
// a summary and as missing in the code, and nobody is wrong. A capability is
// either there, deliberately gone, or not yet — and if it is genuinely half
// present, that is `pending` with a note, not a fourth state.
//
// ════ THE COUNTS ════
// Every count is printed beside the command that reproduces it. The plan's
// inherited figures (337 tools, ~291 routes) are claims; this script measures.
//
// Usage:
//   node deploy/checks/check-capability-ledger.mjs           # report drift
//   node deploy/checks/check-capability-ledger.mjs --write   # (re)generate the CSV
//   CAPABILITY_GATE=block node deploy/checks/check-capability-ledger.mjs   # refuse on loss
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const WRITE = process.argv.includes('--write');
const VERBOSE = process.argv.includes('--verbose');
const BLOCK = process.env.CAPABILITY_GATE === 'block';

const CSV_REL = 'deploy/checks/capability-ledger.csv';
const CSV = path.join(ROOT, CSV_REL);

const STATUSES = ['built', 'dropped(OWNER-OK)', 'pending'];

const SRC = /^packages\/server\/src\/.*\.ts$/;
const SHARED = /^packages\/shared\/src\/.*\.ts$/;
const NOT_TEST = (r) => !/(?:^|\/)__tests__\//.test(r) && !/\.(?:test|spec)\.tsx?$/.test(r);

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

const allFiles = tracked();
const serverFiles = allFiles.filter((r) => SRC.test(r) && NOT_TEST(r));
const sharedFiles = allFiles.filter((r) => SHARED.test(r) && NOT_TEST(r));

// ════ 1. TOOLS ════
// A tool is a `name: '<id>'` property whose object also carries an
// `input_schema` within the next few lines — the literal shape every
// ToolDefinition in this codebase has (agent/tools.ts:1040 before the split;
// agent/tools/definitions.ts now).
//
// ⚠ THE FIXED LINE WINDOW IS GONE, AND THIS IS THE SECOND TIME IT ROTTED.
// It was 12 and under-counted; PHASE-5 T7 widened it to 16 because T1 had put an
// `effects:` declaration and sometimes a `fields:` block between `name:` and
// `input_schema:`. PHASE-5 T8 (T8H) measured it again and it had rotted AGAIN,
// for exactly the same reason one step later: T8's declaration corrections carry
// a REASON above the effect they add, and a reason is lines. At `3f65d66` —
// before this task changed anything — `image_create` (distance 20) and
// `pdf_create` (distance 16) were both already outside the window and were being
// reported as LOST CAPABILITY that is plainly in the tree; `transcribe_audio`
// joined them the moment T8H declared its transcoder.
//
// A number that has to be re-calibrated every time a declaration gains a
// sentence is not a measurement, it is a countdown. So the window is now the
// ENCLOSING OBJECT LITERAL, found by brace depth from the `name:` line: a tool
// is a `name: '<id>'` property whose own object also carries `input_schema`,
// which is the actual shape and cannot drift. Widening in this direction can
// only ever find MORE definitions, never fewer, so it cannot hide a real
// deletion — a tool removed from the tree has no enclosing object to scan at any
// depth, which is the planted-fault proof recorded with this change.
const COMMANDS = {};
COMMANDS.tool = String.raw`node -e "…" # name:'<id>' whose ENCLOSING OBJECT LITERAL also carries input_schema, over packages/server/src/**/*.ts minus tests`;
function extractTools() {
  const out = [];
  for (const rel of serverFiles) {
    const lines = read(rel).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*name:\s*'([a-z0-9_]+)'\s*,\s*$/.exec(lines[i]);
      if (!m) continue;
      if (!enclosingObjectHasInputSchema(lines, i)) continue;
      out.push({ kind: 'tool', id: m[1], where: `${rel}:${i + 1}` });
    }
  }
  return out;
}

/**
 * Does the object literal CONTAINING line `i` also declare `input_schema`?
 *
 * Walks forward tracking net brace depth from the `name:` line. Depth going
 * negative is the `}` that closes the object the property belongs to, so the
 * span examined is exactly that object and nothing after it — no line count to
 * calibrate and nothing to re-tune when a declaration grows.
 */
function enclosingObjectHasInputSchema(lines, i) {
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    // Strip line comments and string literals so a brace inside a description
    // (`"use {this} shape"`) cannot close the object early.
    const code = lines[j]
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/\/\/.*$/, '');
    if (j > i && /^\s*input_schema\s*:/.test(code) && depth === 0) return true;
    for (const ch of code) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth < 0) return false; // the enclosing object closed
      }
    }
  }
  return false;
}

// ════ 2. ROUTES ════
// The mount table in gateway/server.ts turns a router-local path into the real
// API path, so the id is what a caller would actually request.
COMMANDS.route = String.raw`command grep -anI "app.route(" packages/server/src/gateway/server.ts   # mounts` + '\n'
  + '               ' + String.raw`command grep -anIE "Router\.(get|post|put|patch|delete)\(" packages/server/src/gateway/routes/*.ts   # registrations`;
function extractRoutes() {
  const mounts = new Map();
  const serverTs = 'packages/server/src/gateway/server.ts';
  if (allFiles.includes(serverTs)) {
    for (const m of read(serverTs).matchAll(/\bapp\s*\.\s*route\s*\(\s*['"`]([^'"`]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)/g)) {
      if (!mounts.has(m[2])) mounts.set(m[2], m[1]);
    }
  }
  const out = [];
  for (const rel of serverFiles) {
    const src = read(rel);
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]*)['"`]/g)) {
      const [, obj, verb, p] = m;
      if (!/router|app/i.test(obj)) continue;
      const prefix = mounts.get(obj) ?? (obj === 'app' ? '' : `<${obj}>`);
      const full = (prefix + p).replace(/\/+$/, '') || '/';
      out.push({ kind: 'route', id: `${verb.toUpperCase()} ${full}`, where: `${rel}:${lineOf(src, m.index)}` });
    }
  }
  return out;
}

// ════ 3. CHANNELS ════
// The declared unions are the authority, not scattered string literals:
// shared/src/visibility.ts ChannelKind and shared/src/origin.ts Channel.
COMMANDS.channel = String.raw`command grep -anI "type Channel\b|type ChannelKind\b" packages/shared/src/*.ts`;
function extractChannels() {
  const out = [];
  for (const rel of sharedFiles) {
    const src = read(rel);
    for (const m of src.matchAll(/\bexport\s+type\s+(Channel|ChannelKind)\s*=\s*([^;]+);/g)) {
      for (const lit of m[2].matchAll(/'([^']+)'/g)) {
        if (!out.some((o) => o.id === lit[1])) {
          out.push({ kind: 'channel', id: lit[1], where: `${rel}:${lineOf(src, m.index)}` });
        }
      }
    }
  }
  return out;
}

// ════ 4. WATCHERS ════
// A watcher is an exported `start*` entry point under services/.
COMMANDS.watcher = String.raw`command grep -anI "export function start" packages/server/src/services/*.ts`;
function extractWatchers() {
  const out = [];
  for (const rel of serverFiles.filter((r) => r.startsWith('packages/server/src/services/'))) {
    const src = read(rel);
    for (const m of src.matchAll(/\bexport\s+(?:async\s+)?function\s+(start[A-Z]\w*)\s*\(/g)) {
      out.push({ kind: 'watcher', id: m[1], where: `${rel}:${lineOf(src, m.index)}` });
    }
  }
  return out;
}

// ════ 5. PERIODIC JOBS ════
// Every `setInterval` site. Deliberately unfiltered: a per-session heartbeat and
// a nightly sweep are both things that would be missed if they vanished, and
// deciding which is "really" a job is a judgement the CSV's note column records
// rather than a rule this extractor guesses at.
COMMANDS.job = String.raw`command grep -anI "setInterval(" packages/server/src/**/*.ts   # every site, unfiltered`;
function extractJobs() {
  const out = [];
  // ⚠ THE ID USED TO END IN THE LINE NUMBER, WHICH CONTRADICTED ITS OWN COMMENT
  // (PHASE-5 T7). "so the id survives a line shift" was the stated intent and
  // `#${line}` defeated it: every job in a file that gained a line became a LOST
  // capability and a NEW one in the same breath — 18 of them at this phase's
  // exit, all of them the same intervals a few lines further down. The suffix is
  // now an ORDINAL within its (file, function), which keeps several sites in one
  // function distinct — `index.ts:main` has three — and only changes when the
  // COUNT changes, which is the thing worth noticing. `where` still carries the
  // real line, refreshed by --write.
  const seen = new Map();
  for (const rel of serverFiles) {
    const src = read(rel);
    for (const m of src.matchAll(/\bsetInterval\s*\(/g)) {
      const line = lineOf(src, m.index);
      // Name it by the nearest enclosing function, so the id survives a line shift.
      const before = src.slice(0, m.index);
      const fn = [...before.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)].pop();
      const base = `${path.posix.basename(rel, '.ts')}:${fn ? fn[1] : 'module'}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({ kind: 'job', id: `${base}#${n}`, where: `${rel}:${line}` });
    }
  }
  return out;
}

// ── Build the inventory ──
const inventory = [
  ...extractTools(),
  ...extractRoutes(),
  ...extractChannels(),
  ...extractWatchers(),
  ...extractJobs(),
];
const KINDS = ['tool', 'route', 'channel', 'watcher', 'job'];
const key = (e) => `${e.kind}\t${e.id}`;
const inTree = new Map();
for (const e of inventory) if (!inTree.has(key(e))) inTree.set(key(e), e);

// ── CSV ──
const csvEscape = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '').trim());
}

if (WRITE) {
  const existing = fs.existsSync(CSV) ? parseCsv(fs.readFileSync(CSV, 'utf8')) : [];
  const prior = new Map();
  for (const r of existing.slice(1)) if (r[0] && r[1]) prior.set(`${r[0]}\t${r[1]}`, { status: r[3], note: r[4] ?? '' });

  const lines = ['kind,id,where,status,note'];
  for (const kind of KINDS) {
    for (const e of inventory.filter((x) => x.kind === kind).sort((a, b) => a.id.localeCompare(b.id))) {
      const k = key(e);
      if (lines.some((l) => l.startsWith(`${kind},${csvEscape(e.id)},`))) continue;
      const was = prior.get(k);
      // A row already recorded keeps its status and note; only `where` refreshes.
      const status = was && STATUSES.includes(was.status) ? was.status : 'built';
      lines.push([kind, e.id, e.where, status, was?.note ?? ''].map(csvEscape).join(','));
    }
  }
  // Rows the CSV had that the tree no longer shows are KEPT, so a loss cannot be
  // erased by regenerating the file. Their status is left exactly as recorded.
  for (const [k, v] of prior) {
    if (inTree.has(k)) continue;
    const [kind, id] = k.split('\t');
    lines.push([kind, id, '(not found in the tree)', v.status, v.note].map(csvEscape).join(','));
  }
  fs.writeFileSync(CSV, lines.join('\n') + '\n');
  console.log(`wrote ${CSV_REL}: ${lines.length - 1} row(s)`);
  console.log('');
}

if (!fs.existsSync(CSV)) {
  console.error(`✗ ${CSV_REL} not found. The capability ledger has nothing to compare the tree against.`);
  console.error('  Seed it once, in a gate-side-only commit:');
  console.error('     node deploy/checks/check-capability-ledger.mjs --write');
  console.error('  Refusing rather than passing: with no ledger, every capability would read as present.');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const header = rows[0] ?? [];
const declared = new Map();
const badStatus = [];
for (const r of rows.slice(1)) {
  const [kind, id, where, status, note] = r;
  if (!kind || !id) continue;
  if (!STATUSES.includes(status)) badStatus.push({ kind, id, status });
  declared.set(`${kind}\t${id}`, { kind, id, where, status, note: note ?? '' });
}

// ── Compare ──
const lost = [];        // recorded `built`, no longer in the tree
const undeclared = [];  // in the tree, not in the ledger
const resurrected = []; // recorded `dropped(OWNER-OK)` but present
const arrived = [];     // recorded `pending` and now present

for (const [k, d] of declared) {
  const present = inTree.has(k);
  if (d.status === 'built' && !present) lost.push(d);
  if (d.status === 'dropped(OWNER-OK)' && present) resurrected.push(d);
  if (d.status === 'pending' && present) arrived.push(d);
}
for (const [k, e] of inTree) if (!declared.has(k)) undeclared.push(e);

// ── Report ──
console.log('Capability ledger — silent-loss detector');
console.log('');
console.log('  Measured in the tree, each beside the command that reproduces it:');
for (const kind of KINDS) {
  const n = inventory.filter((e) => e.kind === kind).length;
  const distinct = [...inTree.keys()].filter((k) => k.startsWith(`${kind}\t`)).length;
  console.log(`     ${(kind + 's').padEnd(9)} ${String(distinct).padStart(5)}${n !== distinct ? `  (${n} sites, ${n - distinct} duplicate id(s))` : ''}`);
  console.log(`               ${COMMANDS[kind]}`);
}
console.log('');
console.log(`  ledger ${CSV_REL}: ${declared.size} row(s), header [${header.join(', ')}]`);
const byStatus = {};
for (const d of declared.values()) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
console.log(`     ${Object.entries(byStatus).map(([s, n]) => `${s}=${n}`).join('  ') || '(empty)'}`);
console.log('');

let failed = false;

if (badStatus.length) {
  failed = true;
  console.error(`✗ ${badStatus.length} row(s) carry a status outside the three allowed states:`);
  for (const b of badStatus.slice(0, 15)) console.error(`     ${b.kind} ${b.id} → "${b.status}"`);
  console.error(`  Allowed, and there are exactly three: ${STATUSES.join(' | ')}`);
  console.error('  There is no `partial` by design — a half-carried capability reads as done in a');
  console.error('  summary and missing in the code, and that ambiguity is how this project grew five');
  console.error('  tracking systems. Record it as `pending` with a note saying what exists.');
  console.error('');
}

if (lost.length) {
  console.log(`  ── ${lost.length} capability recorded \`built\` is NOT in the tree ──`);
  for (const l of (VERBOSE ? lost : lost.slice(0, 25))) {
    console.log(`     ${l.kind.padEnd(8)} ${l.id}`);
    console.log(`              was at ${l.where}${l.note ? `  — ${l.note}` : ''}`);
  }
  if (!VERBOSE && lost.length > 25) console.log(`     … ${lost.length - 25} more (--verbose)`);
  console.log('');
  console.log('  This is the finding this ledger exists for: something the platform could do, and');
  console.log('  now cannot, with no test to notice. For each one, either restore it, or change the');
  console.log('  row to `dropped(OWNER-OK)` with the owner\'s decision in the note — never delete the');
  console.log('  row, because a deleted row is how the loss becomes invisible again.');
  console.log('');
  if (BLOCK) failed = true;
}

if (resurrected.length) {
  console.log(`  ── ${resurrected.length} capability recorded \`dropped(OWNER-OK)\` is present in the tree ──`);
  for (const r of resurrected.slice(0, 15)) console.log(`     ${r.kind.padEnd(8)} ${r.id}   ${r.note}`);
  console.log('  Either it came back and the row should say `built`, or the drop never happened.');
  console.log('');
}

if (arrived.length) {
  console.log(`  ── ${arrived.length} capability recorded \`pending\` is now present ──`);
  for (const a of arrived.slice(0, 15)) console.log(`     ${a.kind.padEnd(8)} ${a.id}`);
  console.log('  Move these to `built` so the ledger keeps describing the tree.');
  console.log('');
}

if (undeclared.length) {
  const byKind = {};
  for (const u of undeclared) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  console.log(`  ── ${undeclared.length} capability in the tree is not in the ledger ── (${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(', ')})`);
  for (const u of (VERBOSE ? undeclared : undeclared.slice(0, 20))) {
    console.log(`     ${u.kind.padEnd(8)} ${u.id}   ${u.where}`);
  }
  if (!VERBOSE && undeclared.length > 20) console.log(`     … ${undeclared.length - 20} more (--verbose)`);
  console.log('  New capability is not a defect — record it:  --write  (a gate-side-only commit).');
  console.log('');
  if (BLOCK) failed = true;
}

if (failed) {
  console.error(`✗ capability ledger: refusing (CAPABILITY_GATE=block).`);
  process.exit(1);
}

if (!lost.length && !undeclared.length && !resurrected.length && !arrived.length && !badStatus.length) {
  console.log('✓ capability ledger clean — the tree and the ledger agree on every row.');
} else {
  console.log(`  REPORTING, not refusing. Set CAPABILITY_GATE=block to make loss and undeclared`);
  console.log('  capability fail the build — the same switch shape the orphan gate uses.');
}
process.exit(0);
