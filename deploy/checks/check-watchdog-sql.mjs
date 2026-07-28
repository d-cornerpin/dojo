#!/usr/bin/env node
// ════════════════════════════════════════
// Every SQL statement in `watchdog/src` PREPARES against the migrated schema.
//
// ── WHY THIS EXISTS, and it is not hypothetical ──
// PHASE-1 T10 (2026-07-28) found that `watchdog/src/index.ts`'s unanswered-backlog
// query had been THROWING since migration 129 — `no such column: m.origin_kind` —
// and because it shares one try/catch with the stalled-agent probe, BOTH halves of
// watchdog agent supervision were silently dead for a day. Nothing went red. The
// watchdog kept running, kept logging its heartbeat, and simply stopped supervising.
//
// The cause was a SCOPE HOLE, not a typo. T6 (migration 129, the column drop) and
// T6b (migration 131, epoch-ms time) each re-derived their reader sets over
// `packages/{server,shared,dashboard}/src`. `watchdog/` is deliberately NOT under
// `packages/` — the very independence `check-watchdog-contract.mjs` enforces is what
// put it outside both scans. T6's tombstone claim of "ZERO reader sites" was true for
// the corpus it scanned and false for the tree.
//
// A grep-based rule cannot close that class: the next task will scope to `packages/`
// again, and no list of column names stays current. So this gate does not grep. It
// BUILDS the schema the migration chain produces and asks SQLite to prepare every
// statement the watchdog actually runs. A dropped column, a renamed table, a typo'd
// alias — SQLite refuses it here, at build time, instead of at 3am inside a catch.
//
// ── WHAT IT DOES NOT CATCH, said out loud ──
// Preparing proves the statement is VALID against the schema. It does not prove the
// statement is CORRECT. The same T10 finding had a second half a prepare-check cannot
// see: `m.created_at` (epoch-ms INTEGER) compared against `a.session_started_at`
// (TEXT), which SQLite happily prepares and which is then constantly false, because
// INTEGER sorts before TEXT unconditionally. That half needs a human or a fixture, and
// the repaired query carries its own measurement at the site. This gate closes the
// "it throws" half of the class, which is the half that was invisible.
//
// ── THE SCHEMA IS REPO-CONTAINED ──
// Built in memory from `packages/server/src/db/migrations.ts` (its CREATE-TABLE
// `db.exec` blocks) plus every `packages/server/src/db/migrations/*.sql`, applied in
// the runner's own order with `foreign_keys = OFF`, exactly as `runMigrations` does.
// The live `~/.dojo` database is NEVER consulted — same rule as check-orphans.mjs: a
// gate that reads a developer's box measures that box, not the build.
//
// A free consequence worth naming: applying the whole chain to an EMPTY database is a
// fresh-install rehearsal. A migration that only works on this box's data fails here.
//
// ── SEED DATA IS DELIBERATELY NOT APPLIED ──
// `migrations.ts` also holds an INSERT-only `db.exec` block (the `__system__` provider
// and the `auto` sentinel model) which runs AFTER the file chain, not in textual order.
// Only blocks containing CREATE TABLE are applied, so this gate never has to guess an
// execution order: it builds SCHEMA, and schema is all a prepare needs.
//
// ── BITE-PROOF ──
// Section 3 prepares two control statements against the same schema — one valid, one
// naming a column migration 129 dropped (the real T10 defect) — and fails if the
// second one does NOT throw. A gate that cannot demonstrate it bites is decoration.
//
// Usage:
//   node deploy/checks/check-watchdog-sql.mjs     # exit 0 clean, 1 on any violation
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const MIGRATIONS_TS = 'packages/server/src/db/migrations.ts';
const MIGRATIONS_DIR = 'packages/server/src/db/migrations';
// The scope this gate owns: the code that reads the platform's database from OUTSIDE
// `packages/`, which is the corpus every scoped sweep has missed.
const SQL_DIRS = ['watchdog/src'];
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

let failed = false;
const fail = (...lines) => { failed = true; for (const l of lines) console.error(l); };

// ════════ file walking ════════

function walk(absDir, out = []) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, out); }
    else if (SOURCE_EXT.test(e.name)) out.push(abs);
  }
  return out;
}

// ════════ comment stripping ════════
// Same heuristic as check-orphans.mjs / check-watchdog-contract.mjs: block comments go
// unconditionally; `//` only opens a line comment when an even number of quote
// characters precedes it. This matters here for a concrete reason — index.ts's repair
// note contains the words `db.prepare(<the old statement>)` inside a comment, and an
// extractor that read it would try to prepare English.
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
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

/** Read the literal that starts at `open` (index of the opening quote/backtick). */
function readLiteral(text, open) {
  const q = text[open];
  let i = open + 1;
  let buf = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { buf += ch + (text[i + 1] ?? ''); i += 2; continue; }
    if (ch === q) return { value: buf, end: i };
    if (q !== '`' && ch === '\n') return null; // an unterminated single-line literal
    buf += ch;
    i++;
  }
  return null;
}

// ════════ 1. build the schema the migration chain produces ════════

function ddlBlocks(src) {
  const out = [];
  const re = /db\.exec\(\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    const lit = readLiteral(src, re.lastIndex - 1);
    if (!lit) continue;
    out.push({ at: m.index, sql: lit.value });
  }
  return out;
}

function buildSchema() {
  const tsPath = path.join(ROOT, MIGRATIONS_TS);
  const dir = path.join(ROOT, MIGRATIONS_DIR);
  if (!fs.existsSync(tsPath) || !fs.existsSync(dir)) {
    fail(`✗ cannot find ${MIGRATIONS_TS} or ${MIGRATIONS_DIR} — this gate cannot run without the migration chain.`);
    process.exit(1);
  }
  const src = fs.readFileSync(tsPath, 'utf8');
  const all = ddlBlocks(src);
  const ddl = all.filter((b) => /CREATE\s+TABLE/i.test(b.sql));
  // Migration 019's .sql file is a no-op marker; the runner substitutes an inline block.
  // Locate it the way the runner does — by the file name it keys on.
  const idx019 = src.indexOf("'019_agent_sdk_auth.sql'");
  const special019 = idx019 >= 0 ? ddl.find((b) => b.at > idx019) ?? null : null;

  if (ddl.length === 0) {
    fail(
      `✗ no CREATE TABLE db.exec(\`…\`) block found in ${MIGRATIONS_TS}.`,
      '  The base DDL moved or changed shape. Re-sync this gate rather than deleting it —',
      '  a schema builder that silently finds nothing would pass every statement.',
    );
    process.exit(1);
  }

  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // the runner does exactly this for the whole chain
  for (const b of ddl) {
    if (b === special019) continue; // applied in its place in the chain below
    db.exec(b.sql);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = (f === '019_agent_sdk_auth.sql' && special019)
      ? special019.sql
      : fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      db.exec(sql);
    } catch (err) {
      fail(
        `✗ migration ${f} does not apply to an EMPTY database: ${err.message}`,
        '  Every fresh install runs this chain from nothing, so this is a real break, not a',
        '  gate artefact. Fix the migration; this gate cannot check any SQL until it applies.',
      );
      process.exit(1);
    }
  }
  return { db, blocks: ddl.length, files: files.length };
}

const { db, blocks, files } = buildSchema();
const tableCount = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get().c;

// ════════ 2. every prepared statement in scope, prepared for real ════════

const statements = [];
let filesScanned = 0;

for (const dirRel of SQL_DIRS) {
  for (const abs of walk(path.join(ROOT, dirRel))) {
    filesScanned++;
    const rel = path.relative(ROOT, abs);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const re = /\.prepare\(\s*(['"`])/g;
    let m;
    while ((m = re.exec(code))) {
      const lit = readLiteral(code, re.lastIndex - 1);
      if (!lit) continue;
      const line = code.slice(0, m.index).split('\n').length;
      statements.push({ rel, line, sql: lit.value, interpolated: /\$\{/.test(lit.value) });
      re.lastIndex = lit.end;
    }
  }
}

const runnable = statements.filter((s) => !s.interpolated);
const skipped = statements.filter((s) => s.interpolated);

// Vacuity guard. A regex that finds nothing reports a clean sweep, which is exactly the
// shape of failure this gate exists to prevent. The watchdog reads the platform DB by
// design (that is its job); zero statements means the extractor broke, not that the
// reads went away.
if (statements.length === 0) {
  fail(
    `✗ no prepared statements found in ${SQL_DIRS.join(', ')} — the extractor is seeing nothing.`,
    '  The watchdog reads the platform database by design. Zero is not "clean", it is blind.',
    '  Either the SQL moved to a form this gate cannot read, or the scan scope is wrong.',
  );
}

const broken = [];
for (const s of runnable) {
  try {
    db.prepare(s.sql).columns?.();
  } catch (err) {
    // `.columns()` throws on non-SELECTs; only a PREPARE failure is a finding.
    if (!/does not return data/i.test(String(err.message))) {
      broken.push({ ...s, error: err.message });
    }
  }
}

if (broken.length) {
  fail(`✗ ${broken.length} statement(s) in ${SQL_DIRS.join(', ')} do NOT prepare against the migrated schema:`, '');
  for (const b of broken) {
    fail(`  ${b.rel}:${b.line}  →  ${b.error}`);
    fail(`      ${b.sql.trim().replace(/\s+/g, ' ').slice(0, 220)}`, '');
  }
  fail(
    '  This code sits OUTSIDE packages/, so every column sweep scoped to packages/{server,shared,',
    '  dashboard}/src misses it — that is how the backlog query spent a day throwing inside a',
    '  catch with agent supervision dead behind it (PHASE-1 T10 §8). Re-point the statement in the',
    '  SAME commit as the schema change that broke it.',
    '',
  );
}

// ════════ 3. bite-proof: the checker refuses what it is supposed to refuse ════════

{
  const controls = [
    { sql: "SELECT id, name FROM agents WHERE status = 'working'", mustPrepare: true, why: 'a statement that is valid today' },
    // The literal T10 defect: `origin_kind` left `messages` in migration 129.
    { sql: "SELECT m.id FROM messages m WHERE m.origin_kind = 'engine'", mustPrepare: false, why: 'the column migration 129 dropped' },
  ];
  for (const c of controls) {
    let prepared = true;
    try { db.prepare(c.sql); } catch { prepared = false; }
    if (prepared !== c.mustPrepare) {
      fail(
        `✗ bite-proof FAILED: the control "${c.why}" ${prepared ? 'prepared' : 'did not prepare'} and should have done the opposite.`,
        `    ${c.sql}`,
        '  The schema this gate built is not the schema the migration chain produces, so every',
        '  verdict above is unreliable. Fix the builder before trusting a green.',
        '',
      );
    }
  }
}

// ════════ verdict ════════

if (failed) {
  console.error('✗ watchdog SQL: refusing.');
  console.error('  Reproduce by hand:');
  console.error(`    grep -n "\\.prepare(" ${SQL_DIRS.join(' ')}/*.ts`);
  process.exit(1);
}

console.log(
  `✓ watchdog SQL conformant — ${runnable.length} statement(s) in ${filesScanned} file(s) ` +
  `across ${SQL_DIRS.join(', ')} prepare against the migrated schema`,
);
console.log(
  `  schema built in memory from ${MIGRATIONS_TS} (${blocks} DDL block(s)) + ` +
  `${MIGRATIONS_DIR}/*.sql (${files} file(s)) → ${tableCount} table(s); ~/.dojo never read`,
);
if (skipped.length) {
  console.log(`  ${skipped.length} interpolated statement(s) not preparable as written:`);
  for (const s of skipped) console.log(`    ${s.rel}:${s.line}`);
}
console.log('  bite-proof: a statement naming a column migration 129 dropped is still refused');
