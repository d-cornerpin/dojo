#!/usr/bin/env node
// ════════════════════════════════════════
// Orphan-structure gate (Phase 0 T4).
//
// Two rules live here. They protect different things and they fail differently.
//
// ── RULE 1: every declared spine structure needs a production READER ──
// BLOCKING since the PHASE-1 exit (2026-07-28, T13). It was log-only through
// Phases 0 and 1 and the flip was scheduled from the day it shipped.
//
// THE FLIP CHANGED THE DEFAULT, NOT AN ENV VAR — and that is deliberate.
// The plan's wording was "ORPHAN_GATE=block", but `deploy/release.sh:319` invokes
// this checker with no environment at all, so a gate that only bites when someone
// remembers to export a variable would have left the release path measuring
// nothing. `ORPHAN_GATE=block` is still accepted and means exactly what it says;
// `ORPHAN_GATE=warn` is the escape hatch for a worker mid-change who wants the
// report without the refusal. Default = refuse.
//
// The disease this project exists to cure is half-wired structure: a column gets
// added, something writes it, and nothing ever reads it back — so the fact it was
// supposed to carry is still derived by guesswork somewhere else, and now there
// are two mechanisms instead of one. `spine-manifest.json` lists the structures
// that are supposed to be load-bearing; this rule counts who actually reads them.
//
// ── RULE 2: no undeclared work-shaped table ── (ALWAYS blocking, from day one)
// The strategy document names one falsifier for the whole plan: "work/tracker
// unification producing a second system in practice — any new table whose rows
// mirror `work`" (DOJO-OVERHAUL-PLAN Part VI). This is the machine check for it.
// A table that carries an AGENT LINK and a STATE COLUMN is work-shaped in the
// only sense a build can see, and it must be DECLARED in spine-manifest.json.
// An undeclared one fails the build, naming the table and the manifest as the fix.
// Declaring costs one JSON entry and a sentence; that friction is the point.
//
// ════════════════════════════════════════
// THE READER HEURISTIC, AND EXACTLY HOW DUMB IT IS
// ════════════════════════════════════════
// For a COLUMN entry `T.c`, a file counts as a READER when, with comments
// stripped, it contains a string literal that looks like SQL, references table
// `T`, mentions column `c`, and is NOT a write of that column (`INSERT INTO T
// (… c …)` / `UPDATE T SET … c …`). Writes are recognised by the checker itself
// and reported separately — there is no hand-maintained writer list to launder a
// verdict with. For a TYPE entry, a reader is any non-excluded file other than
// the defining file that mentions the identifier in non-comment code.
//
// Scope: `packages/server/src` AND `packages/dashboard/src` (both — an
// enumeration that covers one package is how "no readers" verdicts go wrong).
// Excluded: `__tests__/`, `*.test.*`, `*.spec.*`, `db/migrations/`, and the
// entry's own defining file. Test matches are NEVER counted as readers but are
// always PRINTED: a test-only reader is evidence the structure is not dead
// (roadmap non-negotiable #15).
//
// Known false NEGATIVES (reports "has readers" when it does not):
//   • A SQL statement that joins two tables and happens to alias an unrelated
//     column to the same name (measured example: `healer/diagnostic.ts`
//     `SELECT t.id as task_id … JOIN … NOT EXISTS (SELECT 1 FROM messages m)`
//     counts as a reader of `messages.task_id`).
// Known false POSITIVES (warns about a structure that IS read):
//   • Reads via `SELECT *` plus property access (`row.speaker`) — no column name
//     appears in the SQL, so the read is invisible here.
//   • Reads reached only through the dashboard's JSON API without the server
//     naming the column in SQL.
// False negatives are accepted (the plan says so). False positives are WAIVED
// WITH A REASON: add `{entry, reason, date}` to the manifest's `waivers` array.
// Every honoured waiver is PRINTED and COUNTED on every run, because a waiver
// nobody sees is a hole. More than 5 across Arc 1 means the RULE is wrong and
// the rule gets fixed — that consequence was committed to in advance.
//
// ════════════════════════════════════════
// THREE WAYS A ZERO-READER ENTRY MAY SURVIVE THE FLIP, AND WHY THEY ARE THREE
// ════════════════════════════════════════
// Measured at the PHASE-1 exit: 12 of 19 declared structures had no production
// reader inside the scanned scope. The waiver budget is 5. Waiving twelve would
// have blown the budget by seven AND told a lie about eleven of them, because a
// WAIVER means one specific thing — "the heuristic is wrong, there IS a reader
// here". Most of the twelve are the opposite: the heuristic is exactly right,
// the wiring genuinely does not exist, and a named later phase owes it. Those
// are different facts and they get different words, so that a real orphan can
// never hide behind "the gate is dumb".
//
//   1. `waivers` (budget 5)          — the reader is inside the scanned scope and
//                                      the heuristic cannot see it. The gate is
//                                      wrong. Budgeted, because a rule that needs
//                                      many of these is a rule to fix.
//   2. `zeroReader.kind = "external-reader"` — the reader is REAL and enumerated
//                                      but lives outside `packages/*/src` (the kit
//                                      repository, `watchdog/`, the packaging
//                                      step). Requires the reader's path AND the
//                                      command that proves it, so the claim can be
//                                      re-run rather than believed. Not budgeted:
//                                      it is a scope statement about this gate,
//                                      not a defect in it. (T10's dead watchdog is
//                                      why "outside packages/" is a first-class
//                                      idea here instead of an oversight.)
//   3. `zeroReader.kind = "owed"`     — there is no reader anywhere. A named phase
//                                      owes one. Requires `owner`, `reason`, and a
//                                      date. This is a DEBT, printed in full on
//                                      every run; it is the honest way to say "not
//                                      wired yet" without pretending otherwise.
//
// A zero-reader entry with NONE of the three FAILS the build. That is the flip:
// a new half-wired structure cannot be added without either wiring it or writing
// down, with a date and an owner, that it is not wired. Both dispositions are
// checked for STALENESS every run — an entry that has readers now, or a waiver on
// an entry that also carries a `zeroReader`, is reported so the manifest cannot
// rot into a list of excuses.
//
// Comment stripping is not free of judgement either: `//` is only treated as a
// comment when an even number of quote characters precedes it on the line, so
// `https://…` inside a string survives. Block comments go unconditionally.
//
// ════════════════════════════════════════
// THE WORK-SHAPED DETECTOR
// ════════════════════════════════════════
// Source: REPO-CONTAINED and deterministic — the base DDL in
// `packages/server/src/db/migrations.ts` plus every `packages/server/src/db/
// migrations/*.sql`, applied IN ORDER, honouring later `ALTER TABLE … ADD
// COLUMN`, `DROP TABLE` and `ALTER TABLE … RENAME TO`. The live `~/.dojo`
// database is never consulted: a gate that reads a developer's box measures that
// box, not the build.
//
// A table must be declared when it has BOTH:
//   • an AGENT LINK   — a column named `agent_id` or `*_agent_id`, or any column
//                       whose definition says `REFERENCES agents(…)`; and
//   • a STATE COLUMN  — a column named `state`, `status`, `outcome`, or ending
//                       `_state` / `_status` / `_outcome`.
//
// DEVIATION FROM THE PLAN'S WORDING, and the measurement that forced it: the
// plan says "any table carrying `agent_id` plus a state column with a terminal
// state". Measured at HEAD, the canonical work table — `tasks` — has NEITHER a
// column named `agent_id` (it links agents through `assigned_to TEXT REFERENCES
// agents(id)`) NOR any terminal literal in its own DDL (`status TEXT DEFAULT
// 'on_deck'`; the terminal values live in application code). The literal rule
// would therefore have been blind to the exact family it was written to catch.
// So the DECLARATION trigger is the structural shape above, and the terminal-
// state test moved to CLASSIFICATION: each declared table records
// `workShaped: true|false` plus the terminal literals found in its migration
// text. Anti-laundering: a table whose migration text DOES show a terminal
// literal may not be declared `workShaped: false` — that fails the build.
// Declaring `workShaped: true` without migration evidence is always allowed
// (that is a human knowing more than the parser, which is fine).
//
// Terminal vocabulary (documented, deliberately tight):
//   done · complete · completed · failed · closed · abandoned · cancelled ·
//   canceled · resolved
// The plan's list plus both spellings of "cancel" plus `resolved` — measured
// reason: `open_loops`, one of the five partial work-tracking systems the plan
// names, uses `resolved` as its terminal state, and without it the gate would
// classify a real work tracker as not work-shaped. Deliberately EXCLUDED:
// `error`, `terminated`, `delivered`, `approved`, `denied`, `stale` — these are
// lifecycle or transport words (`agents.status` carries 'error'/'terminated' for
// a process, not a unit of work), and admitting them would make the
// classification meaningless.
//
// ════════════════════════════════════════
// Usage:
//   node deploy/checks/check-orphans.mjs                    # BLOCKING (since PHASE-1 exit)
//   ORPHAN_GATE=block node deploy/checks/check-orphans.mjs  # the same thing, said explicitly
//   ORPHAN_GATE=warn  node deploy/checks/check-orphans.mjs  # report only; never fails on readers
//   node deploy/checks/check-orphans.mjs --explain <id>     # show every site considered for one entry
//
// Implementation note (deliberate deviation from "count reader files via
// `grep -raE`"): the matching runs in Node against the files directly rather
// than shelling out. `grep` on this workspace's box is ugrep 7.5.0 wearing the
// name `grep`, and `\b`, `-a` and `-r` are not portable across ugrep/GNU/BSD —
// a gate whose verdict depends on which grep is installed is not a gate. The
// coarse `grep` command that reproduces the candidate set by hand is PRINTED
// beside every count, and `--explain` shows the exact statements behind it.
// ════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const MANIFEST_REL = 'deploy/checks/spine-manifest.json';
const MANIFEST = path.join(ROOT, MANIFEST_REL);

const SEARCH_DIRS = ['packages/server/src', 'packages/dashboard/src'];
const SOURCE_EXT = /\.(?:ts|tsx|js|mjs)$/;
const EXCLUDED = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[jt]sx?$|(?:^|\/)db\/migrations\//;

const BASE_DDL_REL = 'packages/server/src/db/migrations.ts';
const MIGRATIONS_REL = 'packages/server/src/db/migrations';

const AGENT_LINK = /^agent_id$|_agent_id$/i;
const AGENT_REFERENCE = /REFERENCES\s+agents\s*\(/i;
const STATE_COLUMN = /^(?:state|status|outcome)$|_(?:state|status|outcome)$/i;
const TERMINAL = /'(done|complete|completed|failed|closed|abandoned|cancelled|canceled|resolved)'/gi;

// Blocking by default since the PHASE-1 exit. `ORPHAN_GATE=warn` is the only
// value that turns the reader rule back into a report; anything else (including
// the plan's literal `block`, and the empty environment `release.sh` runs with)
// refuses.
const BLOCK = process.env.ORPHAN_GATE !== 'warn';
const WAIVER_BUDGET = 5; // plan: >5 across Arc 1 means the rule is wrong, not the tree
const ZERO_READER_KINDS = ['external-reader', 'owed'];

// ════════ source text helpers ════════

function listSourceFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (SOURCE_EXT.test(e.name)) out.push(child);
    }
  };
  for (const d of SEARCH_DIRS) walk(d);
  return out.sort();
}

// Read as latin1, never utf8: two files in this tree carry NUL bytes and other
// non-UTF8 sequences (Phase 0 T1). latin1 is byte-preserving, so nothing is
// silently replaced and no match can be lost to a decoding failure — the same
// reason every grep in this project carries `-a`.
function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'latin1');
}

function stripComments(text) {
  // Block comments first, replaced with equal-length whitespace so line numbers
  // survive for --explain.
  let t = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return t
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i < 0) return line;
      const before = line.slice(0, i);
      const quotes = (before.match(/['"`]/g) ?? []).length;
      return quotes % 2 === 0 ? before : line; // odd → the // sits inside a string
    })
    .join('\n');
}

const SQL_KEYWORD = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
const STRING_LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/** Every SQL-looking string literal in a file, with its 1-based start line. */
function sqlUnits(code) {
  const units = [];
  let m;
  STRING_LITERAL.lastIndex = 0;
  while ((m = STRING_LITERAL.exec(code))) {
    const body = m[0].slice(1, -1);
    if (!SQL_KEYWORD.test(body)) continue;
    units.push({
      // `${…}` interpolations become a placeholder: their contents are JS, not SQL.
      text: body.replace(/\$\{[^}]*\}/g, ' ? '),
      line: code.slice(0, m.index).split('\n').length,
    });
  }
  return units;
}

function unitReferencesTable(unit, table) {
  return new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+\`?${table}\`?\\b|\\b${table}\\.`, 'i').test(unit);
}

/** 'insert' | 'update' when the unit WRITES the column, else null (a read). */
function writeKind(unit, table, column) {
  const ins = new RegExp(`INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+\`?${table}\`?\\s*\\(([^)]*)\\)`, 'i').exec(unit);
  if (ins && new RegExp(`\\b${column}\\b`).test(ins[1])) return 'insert';
  const upd = new RegExp(`UPDATE\\s+\`?${table}\`?\\s+SET\\s+([\\s\\S]*?)(?:\\bWHERE\\b|$)`, 'i').exec(unit);
  if (upd && new RegExp(`\\b${column}\\b`).test(upd[1])) return 'update';
  return null;
}

// ════════ schema model (repo-contained, deterministic) ════════

function stripSqlComments(text) {
  return text.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
}

function ddlSources() {
  const out = [[BASE_DDL_REL, readSource(BASE_DDL_REL)]];
  const dir = path.join(ROOT, MIGRATIONS_REL);
  if (!fs.existsSync(dir)) {
    console.error(`✗ ${MIGRATIONS_REL} not found. The work-shaped detector cannot run without the migration chain.`);
    process.exit(1);
  }
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    out.push([`${MIGRATIONS_REL}/${f}`, readSource(`${MIGRATIONS_REL}/${f}`)]);
  }
  return out;
}

/**
 * Applies the DDL in order and returns the resulting table set. Columns carry the
 * file that introduced them so every declaration in the manifest can be checked
 * against a real defining file.
 */
function buildSchema() {
  const tables = new Map();
  const statementsByTable = new Map();

  for (const [rel, raw] of ddlSources()) {
    const text = stripSqlComments(raw);

    // ── One ordered pass, not four phase passes ──
    // Each DDL form is matched with its offset and then APPLIED IN SOURCE ORDER.
    // The previous shape ran every CREATE, then every ADD COLUMN, then every
    // RENAME, then every DROP, which mis-reads the repo's table-rebuild pattern
    // (`CREATE x_new; INSERT …; DROP x; ALTER TABLE x_new RENAME TO x`, used by
    // migrations 005, 103 and 126): the drop phase ran last and deleted the very
    // table the rename had just produced, so a rebuilt table vanished from the
    // parsed schema. It went unnoticed while only `providers` and
    // `summary_messages` were rebuilt — neither is manifest-declared — and
    // surfaced the moment migration 126 rebuilt `agents`, which is.
    const events = [];
    const push = (re, kind) => {
      let m;
      while ((m = re.exec(text))) events.push({ at: m.index, end: re.lastIndex, kind, m: [...m] });
    };
    push(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?\s*\(/gi, 'create');
    push(/ALTER\s+TABLE\s+[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?\s+ADD\s+(?:COLUMN\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?([^;]*)/gi, 'add');
    push(/ALTER\s+TABLE\s+[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?\s+RENAME\s+TO\s+[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?/gi, 'rename');
    push(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?/gi, 'drop');
    events.sort((a, b) => a.at - b.at);

    for (const ev of events) {
      const m = ev.m;
      if (ev.kind === 'create') {
        const name = m[1];
        let i = ev.end - 1;
        const start = i;
        let depth = 0;
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') { depth--; if (depth === 0) break; }
        }
        const body = text.slice(start + 1, i);
        if (!tables.has(name)) tables.set(name, { name, columns: new Map(), createdIn: rel });
        const t = tables.get(name);
        // split on top-level commas
        let d = 0, cur = '';
        const parts = [];
        for (const ch of body) {
          if (ch === '(') d++;
          if (ch === ')') d--;
          if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
        }
        parts.push(cur);
        for (const p of parts) {
          const s = p.trim().replace(/\s+/g, ' ');
          if (!s || /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(s)) continue;
          const cm = /^[`"']?([A-Za-z_][A-Za-z0-9_]*)[`"']?\s+/.exec(s);
          if (cm) t.columns.set(cm[1], { name: cm[1], definedIn: rel, ddl: s });
        }
      } else if (ev.kind === 'add') {
        const [, tname, cname, rest] = m;
        if (!tables.has(tname)) continue; // ALTER of a table this chain never created
        tables.get(tname).columns.set(cname, {
          name: cname, definedIn: rel, ddl: `${cname}${rest}`.replace(/\s+/g, ' ').trim(),
        });
      } else if (ev.kind === 'rename') {
        const t = tables.get(m[1]);
        if (!t) continue;
        tables.delete(m[1]);
        t.name = m[2];
        tables.set(m[2], t);
      } else {
        tables.delete(m[1]);
      }
    }

    for (const s of text.split(';')) {
      const st = s.replace(/\s+/g, ' ').trim();
      if (!st) continue;
      for (const name of tables.keys()) {
        if (!new RegExp(`\\b${name}\\b`).test(st)) continue;
        if (!statementsByTable.has(name)) statementsByTable.set(name, []);
        statementsByTable.get(name).push({ rel, st });
      }
    }
  }

  return { tables, statementsByTable };
}

/** Terminal literals visible in the migration text for one table.column. */
function terminalEvidence(schema, table, column) {
  const found = new Map(); // literal → where
  const col = schema.tables.get(table)?.columns.get(column);
  if (col) {
    let m;
    TERMINAL.lastIndex = 0;
    while ((m = TERMINAL.exec(col.ddl))) found.set(m[1].toLowerCase(), `${col.definedIn} (column DDL)`);
  }
  for (const { rel, st } of schema.statementsByTable.get(table) ?? []) {
    if (!new RegExp(`\\b${column}\\b`).test(st)) continue;
    const near = new RegExp(`\\b${column}\\b\\s*(?:=|IN|<>|!=)\\s*\\(?((?:\\s*'[^']*'\\s*,?)+)`, 'gi');
    let m;
    while ((m = near.exec(st))) {
      for (const lit of m[1].match(/'[^']*'/g) ?? []) {
        TERMINAL.lastIndex = 0;
        const t = TERMINAL.exec(lit);
        if (t) found.set(t[1].toLowerCase(), rel);
      }
    }
  }
  return found;
}

function workShapedCandidates(schema) {
  const out = [];
  for (const [name, t] of [...schema.tables].sort(([a], [b]) => a.localeCompare(b))) {
    if (name.startsWith('_')) continue; // bookkeeping tables (_migrations and friends)
    const agentCols = [...t.columns.values()]
      .filter((c) => AGENT_LINK.test(c.name) || AGENT_REFERENCE.test(c.ddl))
      .map((c) => c.name);
    if (!agentCols.length) continue;
    const stateCols = [...t.columns.values()].filter((c) => STATE_COLUMN.test(c.name)).map((c) => c.name);
    if (!stateCols.length) continue;
    const terminals = new Map();
    for (const sc of stateCols) for (const [lit, where] of terminalEvidence(schema, name, sc)) terminals.set(`${sc}='${lit}'`, where);
    out.push({ name, createdIn: t.createdIn, agentCols, stateCols, terminals });
  }
  return out;
}

// ════════ manifest ════════

function loadManifest() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`✗ ${MANIFEST_REL} not found. The orphan gate cannot run without it.`);
    process.exit(1);
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    console.error(`✗ ${MANIFEST_REL} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const die = (msg) => { console.error(`✗ ${MANIFEST_REL}: ${msg}`); process.exit(1); };
  if (!Array.isArray(m.structures)) die('must contain a "structures" array.');
  if (!Array.isArray(m.tables)) die('must contain a "tables" array (the work-shaped declarations).');
  if (!Array.isArray(m.waivers)) die('must contain a "waivers" array (may be empty).');
  for (const s of m.structures) {
    if (!s.id || !s.kind) die(`every structure needs "id" and "kind": ${JSON.stringify(s)}`);
    if (s.kind === 'column' && (!s.table || !s.column)) die(`column structure "${s.id}" needs "table" and "column".`);
    if (s.kind === 'type' && !s.identifier) die(`type structure "${s.id}" needs "identifier".`);
    if (!['column', 'type'].includes(s.kind)) die(`structure "${s.id}" has unknown kind "${s.kind}".`);
    if (!s.definedIn) die(`structure "${s.id}" needs "definedIn".`);
    const z = s.zeroReader;
    if (z === undefined) continue;
    if (typeof z !== 'object' || z === null) die(`structure "${s.id}": "zeroReader" must be an object.`);
    if (!ZERO_READER_KINDS.includes(z.kind)) {
      die(`structure "${s.id}": zeroReader.kind must be one of ${ZERO_READER_KINDS.join(' | ')} (got ${JSON.stringify(z.kind)}).`);
    }
    if (!z.reason) die(`structure "${s.id}": zeroReader needs a "reason" — an undated, unexplained survival is what this gate exists to stop.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(z.date ?? '')) die(`structure "${s.id}": zeroReader needs an ISO "date" (got ${JSON.stringify(z.date)}).`);
    if (z.kind === 'owed' && !z.owner) {
      die(`structure "${s.id}": zeroReader.kind "owed" needs an "owner" — the phase or sweep that owes the reader. "Somebody" is not an owner.`);
    }
    if (z.kind === 'external-reader') {
      if (!z.reader) die(`structure "${s.id}": zeroReader.kind "external-reader" needs "reader" — the path of the file that actually reads it.`);
      if (!z.verifiedBy) die(`structure "${s.id}": zeroReader.kind "external-reader" needs "verifiedBy" — the command that re-derives the claim. A reader nobody can re-check is a rumour (#14).`);
    }
  }
  for (const t of m.tables) {
    if (!t.name) die(`every table declaration needs "name": ${JSON.stringify(t)}`);
    if (typeof t.workShaped !== 'boolean') die(`table "${t.name}" needs a boolean "workShaped".`);
    if (!t.why) die(`table "${t.name}" needs a "why" line — a declaration nobody explained is a rubber stamp.`);
  }
  for (const w of m.waivers) {
    if (!w.entry || !w.reason || !w.date) die(`every waiver needs {entry, reason, date}: ${JSON.stringify(w)}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) die(`waiver for "${w.entry}" has a non-ISO date "${w.date}".`);
  }
  return m;
}

// ════════ reader counting ════════

const SOURCES = listSourceFiles();
const CODE = new Map(); // rel → comment-stripped text (read once)
function codeOf(rel) {
  if (!CODE.has(rel)) CODE.set(rel, stripComments(readSource(rel)));
  return CODE.get(rel);
}

function analyseColumn(entry) {
  const { table, column, definedIn } = entry;
  const readers = [], writers = [], testHits = [], sites = [];
  const colRe = new RegExp(`\\b${column}\\b`);
  for (const rel of SOURCES) {
    if (rel === definedIn) continue;
    const code = codeOf(rel);
    if (!colRe.test(code)) continue;
    const hits = sqlUnits(code)
      .filter((u) => unitReferencesTable(u.text, table) && colRe.test(u.text))
      .map((u) => ({ ...u, write: writeKind(u.text, table, column) }));
    if (!hits.length) continue;
    for (const h of hits) sites.push({ rel, ...h });
    const isTest = EXCLUDED.test(rel);
    const reads = hits.some((h) => h.write === null);
    if (isTest) testHits.push({ rel, reads });
    else if (reads) readers.push(rel);
    else writers.push(rel);
  }
  return { readers, writers, testHits, sites };
}

function analyseType(entry) {
  const { identifier, definedIn } = entry;
  const re = new RegExp(`\\b${identifier}\\b`);
  const readers = [], testHits = [], sites = [];
  for (const rel of SOURCES) {
    if (rel === definedIn) continue;
    const code = codeOf(rel);
    if (!re.test(code)) continue;
    const line = code.split('\n').findIndex((l) => re.test(l)) + 1;
    sites.push({ rel, line, text: code.split('\n')[line - 1].trim().slice(0, 120), write: null });
    if (EXCLUDED.test(rel)) testHits.push({ rel, reads: true });
    else readers.push(rel);
  }
  return { readers, writers: [], testHits, sites };
}

function analyse(entry) {
  return entry.kind === 'column' ? analyseColumn(entry) : analyseType(entry);
}

function reproCommand(entry) {
  const ident = entry.kind === 'column' ? entry.column : entry.identifier;
  return `grep -raEl '\\b${ident}\\b' ${SEARCH_DIRS.join(' ')} | grep -vE '__tests__|\\.test\\.|\\.spec\\.'`;
}

// ════════════════════════════════════════
// RUN
// ════════════════════════════════════════

const manifest = loadManifest();
const schema = buildSchema();

// ── --explain <id> ──
const explainIdx = process.argv.indexOf('--explain');
if (explainIdx !== -1) {
  const id = process.argv[explainIdx + 1];
  const entry = manifest.structures.find((s) => s.id === id);
  if (!entry) {
    console.error(`✗ no structure "${id}" in ${MANIFEST_REL}. Known: ${manifest.structures.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }
  const r = analyse(entry);
  console.log(`${entry.id} (${entry.kind}) — defined in ${entry.definedIn}`);
  console.log(`coarse candidate set: ${reproCommand(entry)}\n`);
  if (!r.sites.length) console.log('  no site matched at all.');
  for (const s of r.sites) {
    const kind = s.write ? `WRITE (${s.write})` : 'READ';
    console.log(`  ${EXCLUDED.test(s.rel) ? '[test] ' : ''}${s.rel}:${s.line}  ${kind}`);
    console.log(`      ${(s.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  console.log(`\nreaders ${r.readers.length} · writers ${r.writers.length} · test hits ${r.testHits.length}`);
  process.exit(0);
}

let structuralFailure = false;
let readerFailure = false;

// ════════ RULE 2 (always blocking): every work-shaped table is declared ════════
const candidates = workShapedCandidates(schema);
const declared = new Map(manifest.tables.map((t) => [t.name, t]));
const undeclared = candidates.filter((c) => !declared.has(c.name));
const laundered = candidates.filter((c) => declared.get(c.name)?.workShaped === false && c.terminals.size > 0);
const phantom = manifest.tables.filter((t) => !schema.tables.has(t.name));

console.log(`── work-shaped table rule (always blocking) ──`);
console.log(`  schema parsed from ${BASE_DDL_REL} + ${MIGRATIONS_REL}/*.sql → ${schema.tables.size} live table(s)`);
console.log(`  ${candidates.length} carry an agent link AND a state column; ${manifest.tables.length} declared in ${MANIFEST_REL}`);

if (undeclared.length) {
  structuralFailure = true;
  console.error(`\n✗ ${undeclared.length} UNDECLARED work-shaped table(s):`);
  for (const c of undeclared) {
    console.error(`  ${c.name}  (created in ${c.createdIn})`);
    console.error(`     agent link: ${c.agentCols.join(', ')}   state column: ${c.stateCols.join(', ')}`);
    console.error(`     terminal literals in migration text: ${c.terminals.size ? [...c.terminals.keys()].join(', ') : '(none found)'}`);
  }
  console.error(`  A table with an agent link and a state column mirrors the work spine, and the plan's own`);
  console.error(`  falsifier is "a second tracker system appears in practice". Declare it in ${MANIFEST_REL}`);
  console.error(`  under "tables" with {name, definedIn, agentLink, stateColumn, workShaped, why}. If it really`);
  console.error(`  is not work, say so in "why" — that sentence is the whole point of the rule.`);
}

if (laundered.length) {
  structuralFailure = true;
  console.error(`\n✗ ${laundered.length} table(s) declared workShaped:false whose OWN migration text shows terminal states:`);
  for (const c of laundered) {
    console.error(`  ${c.name}: ${[...c.terminals.entries()].map(([k, v]) => `${k} [${v}]`).join(', ')}`);
  }
  console.error(`  A terminal state in the schema is not a matter of opinion. Set workShaped:true.`);
}

if (phantom.length) {
  structuralFailure = true;
  console.error(`\n✗ ${phantom.length} declared table(s) no longer exist in the migration chain:`);
  for (const t of phantom) console.error(`  ${t.name}`);
  console.error(`  Dropping the table is progress — remove its declaration in the same commit so the manifest`);
  console.error(`  keeps describing the tree instead of rotting into a list of lies.`);
}

// ════════ manifest hygiene: declared structures must still exist ════════
const stale = [];
for (const s of manifest.structures) {
  if (!fs.existsSync(path.join(ROOT, s.definedIn))) { stale.push(`${s.id}: definedIn "${s.definedIn}" does not exist`); continue; }
  if (s.kind === 'column') {
    const t = schema.tables.get(s.table);
    if (!t) stale.push(`${s.id}: table "${s.table}" is not in the migration chain`);
    else if (!t.columns.has(s.column)) stale.push(`${s.id}: column "${s.column}" is not in "${s.table}"`);
  }
}
if (stale.length) {
  structuralFailure = true;
  console.error(`\n✗ ${stale.length} manifest entr(y/ies) no longer describe the tree:`);
  for (const s of stale) console.error(`  ${s}`);
  console.error(`  Update ${MANIFEST_REL} in the same commit as the schema change.`);
}

// ════════ RULE 1: reader counts (log-only unless ORPHAN_GATE=block) ════════
const waived = new Map(manifest.waivers.map((w) => [w.entry, w]));
const zero = [], ok = [], honoured = [], external = [], owed = [];
const doubleClaimed = [];

for (const entry of manifest.structures) {
  const r = analyse(entry);
  const rec = { entry, ...r };
  if (entry.zeroReader && waived.has(entry.id)) doubleClaimed.push(entry.id);
  if (r.readers.length === 0) {
    if (waived.has(entry.id)) honoured.push({ ...rec, waiver: waived.get(entry.id) });
    else if (entry.zeroReader?.kind === 'external-reader') external.push(rec);
    else if (entry.zeroReader?.kind === 'owed') owed.push(rec);
    else zero.push(rec);
  } else ok.push(rec);
}

// A structure may not be BOTH waived ("the gate is wrong") and dispositioned
// ("the gate is right and here is why it survives"). Those are contradictory
// claims about the same entry and one of them is false.
if (doubleClaimed.length) {
  structuralFailure = true;
  console.error(`\n✗ ${doubleClaimed.length} structure(s) carry BOTH a waiver and a zeroReader disposition:`);
  for (const id of doubleClaimed) console.error(`  ${id}`);
  console.error('  A waiver says the heuristic missed a reader; a zeroReader says why a real absence survives.');
  console.error('  Both cannot be true. Keep the one that is.');
}

console.log(`\n── spine reader rule (${BLOCK ? 'BLOCKING — default since the PHASE-1 exit' : 'REPORT ONLY — ORPHAN_GATE=warn is set'}) ──`);
console.log(`  ${manifest.structures.length} declared structure(s); scope ${SEARCH_DIRS.join(' + ')} (${SOURCES.length} source files)`);

for (const rec of ok) {
  console.log(`  ✓ ${rec.entry.id} — ${rec.readers.length} reader file(s): ${rec.readers.join(', ')}`);
  if (rec.writers.length) console.log(`      writers (not readers): ${rec.writers.join(', ')}`);
  if (rec.testHits.length) console.log(`      test files matching (never counted): ${rec.testHits.map((t) => t.rel).join(', ')}`);
}

for (const rec of zero) {
  const label = BLOCK ? '✗' : '⚠';
  const say = BLOCK ? console.error : console.log;
  say(`  ${label} ${rec.entry.id} — ZERO production readers`);
  say(`      defined in: ${rec.entry.definedIn}`);
  if (rec.entry.kind === 'column') {
    say(`      writers found: ${rec.writers.length ? rec.writers.join(', ') : '(none — nothing writes it either)'}`);
  }
  say(`      test files matching: ${rec.testHits.length ? rec.testHits.map((t) => `${t.rel}${t.reads ? ' [reads it]' : ''}`).join(', ') : '(none)'}`);
  say(`      candidate set by hand: ${reproCommand(rec.entry)}`);
  say(`      full site list: node deploy/checks/check-orphans.mjs --explain ${rec.entry.id}`);
}
if (zero.length && BLOCK) readerFailure = true;

if (external.length) {
  console.log(`\n  ${external.length} zero-reader entr(y/ies) whose READER IS REAL AND OUTSIDE THE SCANNED SCOPE:`);
  console.log('  Not a waiver — the gate is not wrong here, its scope simply ends at packages/*/src.');
  console.log('  Each carries the reader and the command that re-derives it; re-run the command, do not trust the line.');
  for (const rec of external) {
    const z = rec.entry.zeroReader;
    console.log(`    ${rec.entry.id} — ${z.date}: reader ${z.reader}`);
    console.log(`        verify: ${z.verifiedBy}`);
    console.log(`        ${z.reason}`);
  }
}

if (owed.length) {
  console.log(`\n  ${owed.length} zero-reader entr(y/ies) DECLARED AS DEBT — no reader exists anywhere, a named owner owes one:`);
  console.log('  This list is the phase-exit report. It is printed in full on every run, forever, until it is empty.');
  for (const rec of owed) {
    const z = rec.entry.zeroReader;
    console.log(`    ${rec.entry.id} — ${z.date} · owner ${z.owner}`);
    console.log(`        ${z.reason}`);
    if (rec.entry.kind === 'column') {
      console.log(`        writers today: ${rec.writers.length ? rec.writers.join(', ') : '(none — not even written)'}`);
    }
  }
}

const staleDispositions = manifest.structures.filter(
  (s) => s.zeroReader && ok.some((r) => r.entry.id === s.id),
);
if (staleDispositions.length) {
  console.log(`\n  ${staleDispositions.length} STALE zeroReader disposition(s) — the entry has production readers now, so the note can go:`);
  for (const s of staleDispositions) console.log(`    ${s.id} — ${s.zeroReader.date} (${s.zeroReader.kind})`);
}

if (honoured.length) {
  console.log(`\n  ${honoured.length} WAIVED zero-reader entr(y/ies) — every one is printed on every run, by design:`);
  for (const h of honoured) console.log(`    ${h.entry.id} — ${h.waiver.date}: ${h.waiver.reason}`);
}
const staleWaivers = manifest.waivers.filter((w) => !honoured.some((h) => h.entry.id === w.entry));
if (staleWaivers.length) {
  console.log(`\n  ${staleWaivers.length} STALE waiver(s) — the entry has readers now, so the waiver can go:`);
  for (const w of staleWaivers) console.log(`    ${w.entry} — ${w.date}: ${w.reason}`);
}
console.log(`\n  waivers on file: ${manifest.waivers.length}/${WAIVER_BUDGET} of the Arc-1 budget`);
if (manifest.waivers.length > WAIVER_BUDGET) {
  console.log(`  ⚠ MORE THAN ${WAIVER_BUDGET} WAIVERS. The pre-committed consequence applies: the RULE is wrong, not`);
  console.log(`    the tree. Fix the heuristic (or the manifest's scope) rather than adding waiver ${manifest.waivers.length + 1}.`);
}

// ════════ verdict ════════
console.log('');
if (structuralFailure) {
  console.error('✗ orphan gate: refusing. An undeclared work-shaped table (or a manifest that stopped describing the tree) is a build failure, not a review judgment.');
  process.exit(1);
}
if (readerFailure) {
  console.error(`✗ orphan gate: refusing. ${zero.length} declared spine structure(s) have no production reader, no waiver, and no dated zeroReader disposition.`);
  console.error('  Wire it, or say in the manifest why it survives: {"zeroReader":{"kind":"owed","owner":…,"reason":…,"date":…}}');
  console.error('  for a debt a named phase owes, or {"kind":"external-reader","reader":…,"verifiedBy":…,"reason":…,"date":…}');
  console.error('  when the reader is real and simply lives outside packages/*/src.');
  process.exit(1);
}
console.log(
  `✓ orphan gate — ${candidates.length}/${candidates.length} work-shaped table(s) declared; ` +
  `${ok.length} spine structure(s) read, ${zero.length} unexplained zero-reader ` +
  `(${BLOCK ? 'BLOCKING' : 'REPORT ONLY'}), ${external.length} read outside the scan scope, ` +
  `${owed.length} declared as debt, ${honoured.length} waived`,
);
