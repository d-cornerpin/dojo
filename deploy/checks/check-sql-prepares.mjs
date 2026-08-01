#!/usr/bin/env node
// ════════════════════════════════════════
// Every SQL statement in the tree PREPARES against the migrated schema.
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
// statement the code actually runs. A dropped column, a renamed table, a typo'd
// alias — SQLite refuses it here, at build time, instead of at 3am inside a catch.
//
// ── SCOPE: THE WHOLE TREE (PHASE-3 T8G, 2026-07-31) ──
// Born as `check-watchdog-sql.mjs`, scoped to `watchdog/src` (6 statements); renamed
// at the T8G merge because a file called check-WATCHDOG-sql that reads 581 files across
// four directories is a name that lies about its own scope, and a lying name is how the
// next worker re-derives a corpus narrower than the risk. PHASE-3 T0 rehearsed the promotion
// rather than asserting it and measured the residue first; T8G then landed it. The
// scope is now `packages/{server,shared,dashboard}/src` + `watchdog/src` — see
// SQL_SCOPE below, which carries a per-directory blindness floor and the reason for
// each. The original single-directory scope was itself an instance of the class this
// gate exists to refuse: a checker whose corpus is narrower than the risk.
//
// ── WHAT IT DOES NOT CATCH, said out loud ──
// 1. Preparing proves the statement is VALID against the schema. It does not prove the
//    statement is CORRECT. The same T10 finding had a second half a prepare-check
//    cannot see: `m.created_at` (epoch-ms INTEGER) compared against
//    `a.session_started_at` (TEXT), which SQLite happily prepares and which is then
//    constantly false, because INTEGER sorts before TEXT unconditionally. That half
//    needs a human or a fixture. This gate closes the "it throws" half of the class,
//    which is the half that was invisible.
// 2. A statement assembled at runtime — a `${}` template or a `"…" + expression` — is
//    not preparable as written and is COUNTED AND LISTED, never silently dropped.
// 3. A refusal inside a declared skip class (SKIP_CLASSES) is reported by class and
//    count, not investigated. Every class names its reason in source. An
//    UNCLASSIFIED refusal always fails — that is asserted by a control below.
// 4. Statements this gate's extractor cannot see at all: `.prepare(someVariable)`.
//    The blindness floors in SQL_SCOPE are the tripwire for an extractor that breaks.
//
// ── THE SCHEMA IS REPO-CONTAINED ──
// Built in memory from `packages/server/src/db/migrations.ts` (its CREATE-TABLE
// `db.exec` blocks) plus every `packages/server/src/db/migrations/*.sql`, applied in
// the runner's own order with `foreign_keys = OFF`, exactly as `runMigrations` does,
// plus the RUNTIME DDL the runner applies OUTSIDE the .sql chain (RUNTIME_DDL_SOURCES).
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
// ── BITE-PROOF, AND EVERY DEFECT THIS GATE HAS HAD ──
// Section 3 is a control suite, not a comment. It runs on every invocation and it
// carries one named control per defect this gate has ever shipped, so a regression is
// a red gate rather than a silent re-blinding. Each control states what it refuses.
// A gate that cannot demonstrate it bites is decoration.
//
// Usage:
//   node deploy/checks/check-sql-prepares.mjs     # exit 0 clean, 1 on any violation
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const MIGRATIONS_TS = 'packages/server/src/db/migrations.ts';
const MIGRATIONS_DIR = 'packages/server/src/db/migrations';

// ── The scope, with a BLINDNESS FLOOR per directory ──
// A regex that finds nothing reports a clean sweep, which is exactly the shape of
// failure this gate exists to prevent. `min` is not a ratchet and never rises with the
// tree: it is the count below which the only honest reading is "the extractor broke".
const SQL_SCOPE = [
  {
    dir: 'packages/server/src',
    min: 500,
    why: 'the platform. ~1,800 runnable statements at T8G; anything under 500 means the extractor broke, not that the SQL left.',
  },
  {
    dir: 'packages/shared/src',
    min: 0,
    why: 'no SQL today BY DESIGN — shared holds types and constants, not queries. A floor above 0 would fail on a true fact. It is in scope so that the first query written here is gated on its first day.',
  },
  {
    dir: 'packages/dashboard/src',
    min: 0,
    why: 'no SQL today BY DESIGN — the dashboard talks to the gateway, never to the database. Same reasoning as shared: in scope so a future direct read cannot arrive ungated.',
  },
  {
    dir: 'watchdog/src',
    min: 1,
    why: 'the original scope and the reason this gate exists (PHASE-1 T10). The watchdog reads the platform database by design; zero is not "clean", it is blind.',
  },
];

// ── Runtime DDL the migration runner applies OUTSIDE the .sql chain ──
// PHASE-3 T0 found the gap by widening the scope: `_migrations.checksum` is added by
// `ensureChecksumColumn` on every boot, so the built schema lacked a column two
// production statements name and the gate reported them broken. A builder that
// silently lacks a column is the exact "green because blind" shape this gate refuses,
// so the DDL is EXTRACTED from the runner's own source rather than copied here — a
// hand-copied `ALTER TABLE` would drift the moment the runner changed.
const RUNTIME_DDL_SOURCES = [
  {
    file: 'packages/server/src/db/migration-checksums.ts',
    why: '`ensureChecksumColumn` ALTERs `_migrations` at boot, outside the .sql chain (added 2026-07-29 after migration 139 shipped amended).',
  },
];

// ── Declared skip classes: a refusal here is REPORTED BY CLASS, never investigated ──
// Not a blanket ignore. Each class states its reason, is as narrow as the reason
// allows, and is counted in the output so a skip is visible. An unclassified refusal
// still fails — control `unclassified-refusal-still-fails` asserts exactly that.

// Per-RECEIVER, not per-file, and the difference is load-bearing:
// `services/imessage-bridge.ts` prepares against BOTH databases in one file (9
// statements against the dojo DB, 4 against Apple's). A per-file exemption would
// blind the 9.
const FOREIGN_DB_RECEIVERS = new Map([
  ['chatDb', "Apple Messages' ~/Library/Messages/chat.db, opened read-only — a different database with a different schema this repo does not own"],
]);

// Tables that exist only while one function runs. Matched by NAME against the exact
// `no such table:` error, so an undeclared missing table still fails.
const RUNTIME_TEMP_TABLES = new Map([
  ['_vc_reclaim', 'CREATE TEMP TABLE inside runVaultDiskReclaim (vault/disk-reclaim.ts)'],
  ['_vc_redundant', 'CREATE TEMP TABLE inside runVaultDiskReclaim (vault/disk-reclaim.ts)'],
]);

const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const SKIP_CLASSES = [
  {
    id: 'test-fixture',
    why: 'test files build their own fixture schemas, and several statements are OTHER gates\' deliberate negative controls (work/__tests__/override-sql-prepares.test.ts is itself a bite-proof control). Gating them against the migrated schema would refuse the thing they exist to assert. A test statement that PASSES is still checked; only its refusals are classed.',
    matches: (s) => TEST_FILE.test(s.rel),
  },
  {
    id: 'foreign-database',
    why: 'the statement is prepared against a database this repo does not own, declared by RECEIVER in FOREIGN_DB_RECEIVERS.',
    matches: (s) => s.receiver !== null && FOREIGN_DB_RECEIVERS.has(s.receiver),
  },
  {
    id: 'runtime-temp-table',
    why: 'the statement names a TEMP table the same function creates at runtime, declared in RUNTIME_TEMP_TABLES. Never in the migrated schema by construction.',
    matches: (s, errMsg) => {
      const m = /^no such table: (?:temp\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(errMsg.trim());
      return m !== null && RUNTIME_TEMP_TABLES.has(m[1]);
    },
  },
];

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

// ════════ literal reading ════════

/**
 * Decode the JS escape sequences a source literal carries, so SQLite is asked to
 * prepare the string the ENGINE receives rather than the bytes the file holds.
 *
 * PHASE-3 T0 found this by widening the scope: ten production statements write
 * `datetime(\'now\')` inside a single-quoted JS literal, and the raw text reached
 * SQLite with a literal backslash → `unrecognized token: "\"`. Ten false findings from
 * a checker that had never seen an escaped quote, because `watchdog/src` has none.
 */
function decodeEscapes(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, g) => {
    if (g[0] === 'u') {
      const hex = g[1] === '{' ? g.slice(2, -1) : g.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case '\n': return ''; // a line continuation contributes nothing
      default: return g;    // JS drops the backslash on any other escape
    }
  });
}

/** Read the literal that starts at `open` (index of the opening quote/backtick). Raw. */
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

/**
 * Read a literal AND every `+ "…"` fragment concatenated onto it.
 *
 * PHASE-3 T8G found this by opening the one statement T0's rehearsal could not
 * classify (`gateway/routes/agents.ts:455` → `incomplete input`). It was not a
 * truncation in the product; it was this extractor reading the first fragment of a
 * concatenated statement and calling it the statement. The refusal was the LUCKY
 * case: `prompt/assembler.ts:147`'s first fragment is a complete, valid SELECT, so
 * the gate has been checking half of that statement and reporting a pass — a false
 * GREEN, which is strictly worse than the false red beside it.
 *
 * `dynamic` marks `"…" + expression`: assembled at runtime, not preparable as
 * written, and NEVER preparable as a truncated fragment. Same disposition as `${}`.
 */
function readConcatenated(text, open) {
  const first = readLiteral(text, open);
  if (!first) return null;
  let value = first.value;
  let end = first.end;
  let dynamic = false;
  for (;;) {
    let j = end + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '+') break;
    j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    const ch = text[j];
    if (ch === "'" || ch === '"' || ch === '`') {
      const next = readLiteral(text, j);
      if (!next) { dynamic = true; break; }
      value += next.value;
      end = next.end;
      continue;
    }
    dynamic = true;
    break;
  }
  return { value, end, dynamic };
}

/** The identifier immediately left of `.prepare(` — the connection being asked. */
function receiverBefore(text, idx) {
  let i = idx - 1;
  let out = '';
  while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) { out = text[i] + out; i--; }
  return out === '' ? null : out;
}

/** Every `.prepare(<literal>)` in one file's comment-stripped source. */
function extractStatements(code, rel) {
  const out = [];
  const re = /\.prepare\(\s*(['"`])/g;
  let m;
  while ((m = re.exec(code))) {
    const lit = readConcatenated(code, re.lastIndex - 1);
    if (!lit) continue;
    const sql = decodeEscapes(lit.value);
    const line = code.slice(0, m.index).split('\n').length;
    out.push({
      rel,
      line,
      sql,
      receiver: receiverBefore(code, m.index),
      dynamic: lit.dynamic || /\$\{/.test(lit.value),
    });
    re.lastIndex = lit.end;
  }
  return out;
}

// ════════ 1. build the schema the migration chain produces ════════

function execBlocks(src, quotes = '`') {
  const out = [];
  const re = new RegExp(`db\\.exec\\(\\s*([${quotes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}])`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const lit = readLiteral(src, re.lastIndex - 1);
    if (!lit) continue;
    out.push({ at: m.index, sql: decodeEscapes(lit.value) });
    re.lastIndex = lit.end;
  }
  return out;
}

const ddlBlocks = (src) => execBlocks(src, '`');

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

  // ── the runner's RUNTIME DDL, extracted from the runner's own source ──
  let runtimeDdl = 0;
  for (const s of RUNTIME_DDL_SOURCES) {
    const abs = path.join(ROOT, s.file);
    if (!fs.existsSync(abs)) {
      fail(
        `✗ declared runtime-DDL source ${s.file} does not exist.`,
        `  Declared because: ${s.why}`,
        '  The schema this gate builds would silently lack whatever it applied. Re-point or',
        '  remove the declaration deliberately; do not let it fail open.',
      );
      process.exit(1);
    }
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const stmts = execBlocks(code, '`\'"').filter((b) => /^\s*(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+TABLE)/i.test(b.sql));
    if (stmts.length === 0) {
      fail(
        `✗ declared runtime-DDL source ${s.file} yielded ZERO DDL statements.`,
        `  Declared because: ${s.why}`,
        '  Either the runtime DDL moved (re-point this declaration) or it is genuinely gone',
        '  (delete the declaration). A source that silently yields nothing re-opens the gap',
        '  this declaration was added to close.',
      );
      process.exit(1);
    }
    for (const b of stmts) {
      try { db.exec(b.sql); runtimeDdl++; } catch (err) {
        fail(
          `✗ runtime DDL from ${s.file} does not apply to the migrated schema: ${err.message}`,
          `    ${b.sql.trim().replace(/\s+/g, ' ').slice(0, 200)}`,
        );
        process.exit(1);
      }
    }
  }

  return { db, blocks: ddl.length, files: files.length, runtimeDdl };
}

const { db, blocks, files, runtimeDdl } = buildSchema();
const tableCount = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").get().c;

/** Prepare one statement; return the error message, or null if it compiled. */
// `.columns()` is NOT called. It throws on every non-SELECT ("The columns() method is
// only for statements that return data"), and the filter that was meant to swallow that
// tested for `/does not return data/i` — a message better-sqlite3 does not emit. Inside
// `watchdog/src` every statement is a SELECT, so the filter never fired and the defect
// was invisible; whole-tree it condemns 455 INSERT/UPDATE/DELETEs (measured 2026-07-31 by
// re-planting the defect into this file and re-running it).
// `prepare()` already compiles the statement against the schema, which is the whole
// question, so the call was never needed. Control: `non-select-insert`.
function prepareError(sql) {
  try { db.prepare(sql); return null; } catch (err) { return String(err.message); }
}

// ════════ 2. every prepared statement in scope, prepared for real ════════

const statements = [];
let filesScanned = 0;
const perDir = [];

for (const scope of SQL_SCOPE) {
  let n = 0;
  for (const abs of walk(path.join(ROOT, scope.dir))) {
    filesScanned++;
    const rel = path.relative(ROOT, abs);
    const found = extractStatements(stripComments(fs.readFileSync(abs, 'utf8')), rel);
    n += found.length;
    statements.push(...found);
  }
  perDir.push({ ...scope, found: n });
}

const runnable = statements.filter((s) => !s.dynamic);
const skipped = statements.filter((s) => s.dynamic);

// Blindness floors — see SQL_SCOPE.
for (const d of perDir) {
  if (d.found < d.min) {
    fail(
      `✗ ${d.dir}: ${d.found} prepared statement(s) found, blindness floor is ${d.min}.`,
      `  ${d.why}`,
      '  A regex that finds nothing reports a clean sweep. Either the SQL moved to a form this',
      '  gate cannot read, or the scan scope is wrong. Zero is not "clean", it is blind.',
      '',
    );
  }
}

const broken = [];
const classed = new Map(SKIP_CLASSES.map((c) => [c.id, []]));
for (const s of runnable) {
  const err = prepareError(s.sql);
  if (err === null) continue;
  const cls = SKIP_CLASSES.find((c) => c.matches(s, err));
  if (cls) classed.get(cls.id).push({ ...s, error: err });
  else broken.push({ ...s, error: err });
}

if (broken.length) {
  fail(`✗ ${broken.length} statement(s) do NOT prepare against the migrated schema:`, '');
  for (const b of broken) {
    fail(`  ${b.rel}:${b.line}  →  ${b.error}`);
    fail(`      ${b.sql.trim().replace(/\s+/g, ' ').slice(0, 220)}`, '');
  }
  fail(
    '  Re-point the statement in the SAME commit as the schema change that broke it. If it is',
    '  genuinely not a platform-schema statement, add it to a SKIP_CLASS in this file WITH ITS',
    '  REASON — an unclassified refusal is a finding, and a blanket ignore is how a gate goes',
    '  green by going blind (PHASE-1 T10 §8: both halves of watchdog supervision, dead for a day).',
    '',
  );
}

// ════════ 3. controls: this gate refuses what it is supposed to refuse ════════
// One named control per defect this gate has shipped, plus the two originals. They run
// on every invocation, so a regression is a red gate rather than a silent re-blinding.

const controls = [];
const control = (id, why, run) => controls.push({ id, why, run });
const mustPrepare = (sql) => { const e = prepareError(sql); return { ok: e === null, detail: e ?? 'prepared' }; };
const mustRefuse = (sql) => { const e = prepareError(sql); return { ok: e !== null, detail: e ?? 'PREPARED — the schema this gate built is not the schema the chain produces' }; };

control(
  'valid-today',
  'a statement that is valid against the current schema must prepare',
  () => mustPrepare("SELECT id, name FROM agents WHERE status = 'working'"),
);
control(
  'dropped-column-129',
  'the literal PHASE-1 T10 defect: `origin_kind` left `messages` in migration 129',
  () => mustRefuse("SELECT m.id FROM messages m WHERE m.origin_kind = 'engine'"),
);
control(
  'dropped-column-148',
  'the whole-tree control (T8G): `conv_key` left `messages` in migration 148, after 147 backfilled `conversation_id` from it. A statement still naming it must be refused.',
  () => mustRefuse('SELECT conv_key FROM messages LIMIT 1'),
);
control(
  'non-select-insert',
  'T8G Step 1a: a valid INSERT must be ACCEPTED. The old `.columns()` call threw on every non-SELECT and the filter meant to swallow it tested for a message better-sqlite3 never emits.',
  () => mustPrepare('INSERT INTO agents (id, name) VALUES (?, ?)'),
);
control(
  'non-select-update-delete',
  'T8G Step 1a, the other two shapes',
  () => {
    const a = mustPrepare('UPDATE agents SET name = ? WHERE id = ?');
    const b = mustPrepare('DELETE FROM agents WHERE id = ?');
    return { ok: a.ok && b.ok, detail: a.ok ? b.detail : a.detail };
  },
);
control(
  'js-escaped-quote',
  "T8G Step 1b: a source literal carrying `\\'` must reach SQLite as `'`. Ten production statements write `datetime(\\'now\\')`; the raw bytes give `unrecognized token: \"\\\"`.",
  () => {
    const snippet = String.raw`db.prepare('SELECT datetime(\'now\') AS t')`;
    const [s] = extractStatements(snippet, 'control.ts');
    if (!s) return { ok: false, detail: 'the extractor found no statement in the control snippet' };
    if (s.sql.includes('\\')) return { ok: false, detail: `escape survived into the SQL: ${s.sql}` };
    return mustPrepare(s.sql);
  },
);
control(
  'migrations-checksum-column',
  'T8G Step 1c: `_migrations.checksum` is added by the runner at boot, outside the .sql chain. Both production readers name it; a builder that lacks it is blind to the whole `_migrations` surface.',
  () => {
    const a = mustPrepare('SELECT name, checksum FROM _migrations ORDER BY name');
    const b = mustPrepare('INSERT INTO _migrations (name, checksum) VALUES (?, ?)');
    return { ok: a.ok && b.ok, detail: a.ok ? b.detail : a.detail };
  },
);
control(
  'concatenated-literal',
  'T8G Step 1e: `"…" + "…"` is ONE statement. Reading only the first fragment produced the one refusal T0 could not classify, and — worse — a silent PASS wherever the first fragment happens to parse (prompt/assembler.ts:147).',
  () => {
    const snippet = 'db.prepare("SELECT id FROM agents " + "WHERE no_such_column_xyz = ?")';
    const [s] = extractStatements(snippet, 'control.ts');
    if (!s) return { ok: false, detail: 'the extractor found no statement in the control snippet' };
    if (!s.sql.includes('no_such_column_xyz')) {
      return { ok: false, detail: `the second fragment was dropped — extracted: ${s.sql}` };
    }
    return mustRefuse(s.sql);
  },
);
control(
  'dynamic-concat-is-not-a-statement',
  'T8G Step 1e sibling: `"…" + expression` is assembled at runtime. It must be counted as not-preparable, never prepared as a truncated fragment (which would pass and mean nothing).',
  () => {
    const snippet = 'db.prepare("SELECT * FROM " + tableName)';
    const [s] = extractStatements(snippet, 'control.ts');
    if (!s) return { ok: false, detail: 'the extractor found no statement in the control snippet' };
    return { ok: s.dynamic === true, detail: s.dynamic ? 'marked dynamic' : `prepared a truncated fragment: ${s.sql}` };
  },
);
control(
  'receiver-is-captured',
  'T8G Step 1d: the foreign-database class keys on the RECEIVER, because services/imessage-bridge.ts prepares against both databases in one file. A per-file exemption would blind the 9 dojo-DB statements in it.',
  () => {
    const [s] = extractStatements("chatDb.prepare('SELECT MAX(ROWID) as maxId FROM message')", 'control.ts');
    if (!s) return { ok: false, detail: 'the extractor found no statement in the control snippet' };
    return { ok: s.receiver === 'chatDb', detail: `receiver = ${String(s.receiver)}` };
  },
);
control(
  'unclassified-refusal-still-fails',
  'T8G Step 1d: the skip classes are DECLARED, not a blanket ignore. A refusal that matches no class must remain a finding.',
  () => {
    const s = { rel: 'packages/server/src/not-a-test.ts', line: 1, sql: 'x', receiver: 'db', dynamic: false };
    const hit = SKIP_CLASSES.find((c) => c.matches(s, 'no such table: definitely_not_declared'));
    return { ok: hit === undefined, detail: hit ? `class "${hit.id}" swallowed it` : 'stayed a finding' };
  },
);
control(
  'declared-classes-do-skip',
  'T8G Step 1d: each declared class actually matches the shape it was declared for.',
  () => {
    const cases = [
      ['test-fixture', { rel: 'packages/server/src/agent/__tests__/x.test.ts', receiver: 'db' }, 'no such table: legacy_tasks'],
      ['foreign-database', { rel: 'packages/server/src/services/imessage-bridge.ts', receiver: 'chatDb' }, 'no such table: message'],
      ['runtime-temp-table', { rel: 'packages/server/src/vault/disk-reclaim.ts', receiver: 'db' }, 'no such table: _vc_redundant'],
    ];
    for (const [id, s, err] of cases) {
      const hit = SKIP_CLASSES.find((c) => c.matches(s, err));
      if (!hit || hit.id !== id) return { ok: false, detail: `${id}: matched ${hit ? hit.id : 'nothing'}` };
    }
    return { ok: true, detail: `${cases.length}/${cases.length} classes match their declared shape` };
  },
);

const controlFailures = [];
for (const c of controls) {
  let r;
  try { r = c.run(); } catch (err) { r = { ok: false, detail: `threw: ${err.message}` }; }
  if (!r.ok) controlFailures.push({ ...c, detail: r.detail });
}
if (controlFailures.length) {
  fail(`✗ ${controlFailures.length} control(s) FAILED — every verdict above is unreliable:`, '');
  for (const c of controlFailures) {
    fail(`  control "${c.id}": ${c.detail}`);
    fail(`      ${c.why}`, '');
  }
  fail('  Fix the gate before trusting a green. A gate that cannot demonstrate it bites is decoration.', '');
}

// ════════ verdict ════════

if (failed) {
  console.error('✗ SQL prepares: refusing.');
  console.error('  Reproduce by hand:');
  console.error(`    node deploy/checks/check-sql-prepares.mjs`);
  process.exit(1);
}

console.log(
  `✓ SQL conformant — ${runnable.length} statement(s) in ${filesScanned} file(s) across ` +
  `${SQL_SCOPE.map((s) => s.dir).join(', ')} prepare against the migrated schema`,
);
console.log(
  `  schema built in memory from ${MIGRATIONS_TS} (${blocks} DDL block(s)) + ` +
  `${MIGRATIONS_DIR}/*.sql (${files} file(s)) + ${runtimeDdl} runtime DDL statement(s) ` +
  `→ ${tableCount} table(s); ~/.dojo never read`,
);
console.log(`  per directory: ${perDir.map((d) => `${d.dir} ${d.found} (floor ${d.min})`).join(' · ')}`);
if (skipped.length) {
  console.log(`  ${skipped.length} statement(s) assembled at runtime (\${} or "…" + expr) — not preparable as written`);
}
for (const c of SKIP_CLASSES) {
  const n = classed.get(c.id).length;
  if (n) console.log(`  ${n} refusal(s) in declared class "${c.id}" — ${c.why.split('.')[0]}.`);
}
console.log(`  ${controls.length} control(s) green, incl. columns migrations 129 and 148 dropped`);
