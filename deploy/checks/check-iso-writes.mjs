#!/usr/bin/env node
// ════════════════════════════════════════
// ISO-timestamp trap (Phase 0 T12d Step 1). LOG-ONLY — never fails a build.
//
// SQLite stores this platform's timestamps as `YYYY-MM-DD HH:MM:SS` — the
// `datetime('now')` default on nearly every `*_at` column. JavaScript's
// `toISOString()` produces `YYYY-MM-DDTHH:MM:SS.sssZ`. Both are text, both
// look like a date, and every `ORDER BY <col>` in this codebase compares them
// as TEXT. `T` (0x54) sorts above a space (0x20), so the moment one writer
// puts an ISO string into a column another writer fills with the SQLite form,
// the newer row sorts as the OLDER one:
//
//   sqlite> SELECT '2026-07-25 23:59:59' < '2026-07-25T00:00:00.000Z';
//   1                                    ← 23:59 reads as "before" 00:00 next door
//
// Verified against ~/.dojo/data/dojo.db on 2026-07-27: that expression really
// returns 1, and every populated `*_at` column measured there holds the SQLite
// form today. So the mixture is LATENT, not live — which is exactly when it is
// cheap to name. Phase 1+ makes spine time typed; until then the honest
// posture is a list, not a build failure.
//
// TWO SHAPES ARE MATCHED, both requiring the ISO value to be the thing that
// actually lands in the column:
//
//   A. an object-literal property `<name>_at: <expression calling toISOString()>`
//      — the store-helper shape, e.g. `created_at: new Date().toISOString()`.
//   B. a statement that BINDS an `*_at` column to a placeholder (`updated_at = ?`,
//      or an INSERT whose column list puts `*_at` at a position the VALUES list
//      fills with `?`) while the same call passes a `toISOString()` argument.
//
// `updated_at = datetime('now')` is deliberately NOT a finding — SQLite computes
// that value and it is already the right format. An earlier draft of this check
// flagged those and reported 92 sites; 0 of them were real. Matching in Node
// rather than with a pattern is what makes the difference sayable.
//
// FLOOR, NOT A CENSUS: a value crossing a function boundary is invisible here.
//
// Usage: node deploy/checks/check-iso-writes.mjs [--verbose]
// Always exits 0. This is an instrument, not a gate.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const VERBOSE = process.argv.includes('--verbose');

const IN_SCOPE = /^(?:packages\/[^/]+\/src\/|watchdog\/src\/).*\.(?:ts|tsx)$/;
const EXCLUDED = [/(?:^|\/)__tests__\//, /\.(?:test|spec)\.tsx?$/, /(?:^|\/)db\/migrations\//];

const ISO_CALL = /\.toISOString\s*\(\s*\)/;
// Converting straight back to the SQLite shape makes a site correct, not a finding.
const NORMALIZER = /\.replace\s*\(\s*(['"`])T\1\s*,\s*(['"`])\s\2\s*\)/;

function tracked() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => IN_SCOPE.test(rel) && !EXCLUDED.some((r) => r.test(rel)));
}

/** Strip line and block comments so commented-out code is never a finding. */
function decomment(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// ── Shape A: `<name>_at: <expr with toISOString()>` ──
// The value runs to the next comma at brace-depth 0 or the closing brace, so a
// multi-line ternary is still read as one value.
function shapeA(src, rel, out) {
  const re = /(^|[\s,{[(])(['"`]?)([A-Za-z_$][\w$]*_at)\2\s*:/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const valueStart = m.index + m[0].length;
    let depth = 0;
    let i = valueStart;
    for (; i < src.length; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      else if (c === ';' && depth === 0) break;
    }
    const value = src.slice(valueStart, i);
    if (!ISO_CALL.test(value)) continue;
    if (NORMALIZER.test(value)) continue;
    out.push({
      tier: 'field',
      rel,
      line: src.slice(0, m.index).split('\n').length,
      col: m[3],
      how: 'object property assigned toISOString()',
      text: value.trim().replace(/\s+/g, ' ').slice(0, 120),
    });
  }
}

/**
 * Read a parenthesised list starting at `open` (the index of `(`), honouring
 * nesting and quotes, and split it at top-level commas.
 * `datetime('now')` carries its own parens — an unbalanced `[^)]*` scan stops
 * inside it and silently drops every column after, which is how the first
 * draft of this check missed the real finding in techniques/store.ts.
 */
function parenList(sql, open) {
  let depth = 0;
  let quote = null;
  const parts = [];
  let cur = '';
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') { depth++; if (depth === 1) continue; }
    if (c === ')') { depth--; if (depth === 0) { parts.push(cur); return { parts, end: i }; } }
    if (c === ',' && depth === 1) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null; // unbalanced — refuse to guess
}

/**
 * Read the argument list of a call whose `(` is at `open`, quote-aware, and
 * return the raw text plus the index just past the closing `)`.
 */
function callArgs(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return { text: src.slice(open + 1, i), end: i + 1 }; }
  }
  return null;
}

// ── Shape B: an `*_at` column BOUND to a placeholder in a call passing ISO ──
//
// Anchored on `.prepare(` and read with a quote-aware balanced reader. An
// earlier draft matched template literals with a pattern; because the engine
// may restart a failed span at any character rather than at the next backtick,
// it silently paired a CLOSING backtick with the next OPENING one and missed
// the real finding in techniques/store.ts. Read the call, do not pattern it.
function shapeB(src, rel, out) {
  const prepRe = /\.prepare\s*(?=\()/g;
  let p;
  while ((p = prepRe.exec(src)) !== null) {
    const call = callArgs(src, p.index + p[0].length);
    if (!call) continue;
    const arg = call.text.trim();
    // Only a literal statement is readable; a variable is out of sight.
    if (!/^[`'"]/.test(arg)) continue;
    const sql = arg.slice(1, arg.lastIndexOf(arg[0]));
    if (!/\b(INSERT\s+INTO|UPDATE|REPLACE\s+INTO)\b/i.test(sql)) continue;
    const bound = new Set();

    // `SET updated_at = ?`
    for (const s of sql.matchAll(/\b([a-z_][a-z0-9_]*_at)\s*=\s*\?/gi)) bound.add(s[1].toLowerCase());

    // INSERT INTO t (a, b, created_at) VALUES (?, ?, datetime('now'), ?) — positional
    const ins = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[\w".]+\s*(?=\()/i.exec(sql);
    if (ins) {
      const colList = parenList(sql, ins.index + ins[0].length);
      if (colList) {
        const vm = /VALUES\s*(?=\()/i.exec(sql.slice(colList.end));
        const valList = vm ? parenList(sql.slice(colList.end), vm.index + vm[0].length) : null;
        if (valList && valList.parts.length === colList.parts.length) {
          const cols = colList.parts.map((c) => c.trim().replace(/["`]/g, '').toLowerCase());
          const vals = valList.parts.map((v) => v.trim());
          for (let k = 0; k < cols.length; k++) {
            if (cols[k].endsWith('_at') && vals[k] === '?') bound.add(cols[k]);
          }
        }
      }
    }
    if (!bound.size) continue;

    // The values handed to the statement: the `.run(...)` / `.get(...)` /
    // `.all(...)` chained straight onto this prepare. If it is not chained
    // (`const stmt = db.prepare(...)` used later), the binds are out of sight
    // and this site is left uncounted rather than guessed at.
    const chain = /^\s*\.\s*(run|get|all|iterate)\s*(?=\()/.exec(src.slice(call.end));
    if (!chain) continue;
    const bindCall = callArgs(src, call.end + chain[0].length);
    if (!bindCall) continue;
    if (!ISO_CALL.test(bindCall.text)) continue;
    if (NORMALIZER.test(bindCall.text)) continue;

    out.push({
      tier: 'column',
      rel,
      line: src.slice(0, p.index).split('\n').length,
      col: [...bound].join(', '),
      how: `placeholder-bound column, toISOString() in the .${chain[1]}() argument list`,
      text: sql.trim().replace(/\s+/g, ' ').slice(0, 150),
    });
  }
}

/**
 * Every site writing `<col>` in the SQLite form (`datetime(...)`), anywhere in
 * the scanned tree INCLUDING migrations — a migration is a writer like any
 * other. An ISO write is only a hazard when the SAME column has one of these;
 * that pairing is the whole finding, so it is measured rather than assumed.
 */
function sqliteFormWriters(colNames) {
  const out = new Map(colNames.map((c) => [c, []]));
  if (!colNames.length) return out;
  const all = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => /^packages\/[^/]+\/src\/.*\.(ts|tsx|sql)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel));
  for (const rel of all) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const col of colNames) {
      // `SET col = datetime(...)`, incl. the `COALESCE(col, datetime(...))` idiom.
      const setRe = new RegExp(`\\b${col}\\b\\s*=\\s*(?:COALESCE\\s*\\(\\s*[\\w.]+\\s*,\\s*)?datetime\\s*\\(`, 'gi');
      let m;
      while ((m = setRe.exec(src)) !== null) {
        out.get(col).push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
      // `DEFAULT (datetime('now'))` on the column's own declaration.
      const defRe = new RegExp(`\\b${col}\\b[^,\\n]*DEFAULT\\s*\\(?\\s*datetime\\s*\\(`, 'gi');
      while ((m = defRe.exec(src)) !== null) {
        out.get(col).push(`${rel}:${src.slice(0, m.index).split('\n').length} (column default)`);
      }
    }
  }
  return out;
}

const findings = [];
const files = tracked();
for (const rel of files) {
  const src = decomment(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  if (!ISO_CALL.test(src)) continue;
  shapeA(src, rel, findings);
  shapeB(src, rel, findings);
}

// ── Report ──
const columns = findings.filter((f) => f.tier === 'column');
const fields = findings.filter((f) => f.tier === 'field');

function group(list) {
  const m = new Map();
  for (const f of list) {
    if (!m.has(f.rel)) m.set(f.rel, []);
    m.get(f.rel).push(f);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
}

function print(list, limit) {
  for (const [rel, hits] of group(list)) {
    console.log(`    ${rel}  (${hits.length})`);
    for (const h of (VERBOSE ? hits : hits.slice(0, limit))) {
      console.log(`       :${h.line}  ${h.col}  ← ${h.how}`);
      console.log(`           ${h.text}`);
    }
    if (!VERBOSE && hits.length > limit) console.log(`       … ${hits.length - limit} more here (--verbose)`);
  }
}

console.log('ISO-timestamp trap — REPORT ONLY (this check never fails a build)');
console.log('');
console.log(`  ${columns.length} site(s) binding an ISO string into a DATABASE column  — the sorting hazard`);
console.log(`  ${fields.length} site(s) putting an ISO string in an *_at-named FIELD    — same format split, off the database`);
console.log(`  ${files.length} product source file(s) scanned`);
console.log('');
console.log('  Reproduce this list:   node deploy/checks/check-iso-writes.mjs --verbose');
console.log('  Reproduce the hazard:  sqlite3 -readonly ~/.dojo/data/dojo.db \\');
console.log('                           "SELECT \'2026-07-25 23:59:59\' < \'2026-07-25T00:00:00.000Z\';"   → 1');
console.log('');

if (columns.length) {
  console.log('  ── Reaches a database column (a placeholder this call fills with an ISO string) ──');
  print(columns, 6);
  console.log('');

  // The ISO write alone is harmless. The finding is a column with BOTH kinds
  // of writer, so that pairing is measured rather than assumed.
  const cols = [...new Set(columns.flatMap((f) => f.col.split(',').map((c) => c.trim())))];
  const others = sqliteFormWriters(cols);
  const mixed = cols.filter((c) => (others.get(c) ?? []).length > 0);

  console.log(`  ── Of those ${cols.length} column(s), ${mixed.length} also has a SQLite-form writer: MIXED ──`);
  for (const c of cols) {
    const sites = others.get(c) ?? [];
    if (sites.length) {
      console.log(`     ${c}: MIXED — ${sites.length} site(s) write \`datetime(...)\` into the same column`);
      for (const s of sites.slice(0, VERBOSE ? sites.length : 4)) console.log(`        ${s}`);
      if (!VERBOSE && sites.length > 4) console.log(`        … ${sites.length - 4} more (--verbose)`);
    } else {
      console.log(`     ${c}: single-format — no \`datetime(...)\` writer found for this column`);
    }
  }
  console.log('');
  console.log('  A MIXED column is the live hazard: two writers, two spellings, one TEXT comparison.');
  console.log('  `T` (0x54) sorts above a space (0x20), so the ISO row wins every `ORDER BY` and every');
  console.log('  `<=` against the other form regardless of the instant it names. It surfaces as wrong');
  console.log('  ordering, never as an error. Phase 1+ makes spine time typed; this is the work queue.');
  console.log('');
} else {
  console.log('  No placeholder-bound database column receives an ISO string.');
  console.log('');
}

if (fields.length) {
  console.log('  ── An `*_at`-named field, off the database (a written file, or a row-shaped object) ──');
  print(fields, 6);
  console.log('');
  console.log('  Not the ORDER BY hazard by itself. It matters where the same name carries a different');
  console.log('  format on each side of a boundary — a manifest on disk saying `created_at` in one');
  console.log('  spelling while the row of the same name holds the other. Read the site before acting.');
  console.log('');
}

console.log('  FLOOR, not a census: matched only where the ISO value and the `*_at` target are visible');
console.log('  together — an object property, or a placeholder-bound column whose call passes ISO. A');
console.log('  value crossing a function boundary is NOT counted and NOT claimed to be absent.');
process.exit(0);
