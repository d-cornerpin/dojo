// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B2 — WHAT EACH TABLE AND COLUMN MEANS, READ FROM THE MIGRATIONS THEMSELVES.
//
// The migrations document the schema in prose, and they are the only place that does. This
// reads the same `db/migrations/*.sql` files the migration runner applies, through the runner's
// own `migrationFileNames` / `readMigrationFile`, once per process and in the runner's order, so
// a later migration's note replaces an earlier one's. Three forms are read:
//
//   a table's meaning   an inline comment on its CREATE TABLE line, else the first line of the
//                       file's header (its migration number stripped);
//   header column notes `--   name   text` lines in the header, with deeper-indented lines
//                       continuing them, for the tables the file creates or alters;
//   inline column notes a comment beside a column definition (or on the lines directly above
//                       it) inside CREATE TABLE, and beside ALTER TABLE … ADD COLUMN.
// A note is only shown for a column the live table actually has, so a header line that merely
// looks like one (a state value, a word in prose) is never attached to anything.
// ════════════════════════════════════════════════════════════════════════════════════════

import { migrationFileNames, readMigrationFile } from '../db/migrations.js';

export interface SchemaNotes { tables: Map<string, string>; columns: Map<string, Map<string, string>> }

const CONSTRAINT = /^(CHECK|PRIMARY|FOREIGN|UNIQUE|CONSTRAINT)\b/i;
const HEADER_COLUMN = /^--(\s{2,})([a-z_][a-z0-9_]*)(\s{2,}|\s+—\s+)(\S.*)$/;

let cached: SchemaNotes | null = null;

function noteFor(map: Map<string, Map<string, string>>, table: string): Map<string, string> {
  let m = map.get(table);
  if (!m) { m = new Map(); map.set(table, m); }
  return m;
}

/** The code part and the comment part of one SQL line (a `--` inside a quote is rare here). */
function split(line: string): { code: string; comment: string | null; at: number } {
  const at = line.indexOf('--');
  return at === -1 ? { code: line, comment: null, at: -1 } : { code: line.slice(0, at), comment: line.slice(at + 2).trim(), at };
}

/** The column names a line of a CREATE TABLE body defines. */
function columnsOn(code: string): string[] {
  const out: string[] = []; let depth = 0; let seg = '';
  for (const ch of `${code},`) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth <= 0) {
      const name = /^\s*["`[]?([A-Za-z_][A-Za-z0-9_]*)/.exec(seg)?.[1];
      if (name && !CONSTRAINT.test(seg.trim())) out.push(name.toLowerCase());
      seg = ''; continue;
    }
    seg += ch;
  }
  return out;
}

const stripNumber = (s: string): string => s.replace(/^\d+[a-z]?(_[a-z0-9_]+\.sql)?\s*(\([^)]*\))?\s*[:—–-]\s*/i, '').trim();

function parseFile(text: string, notes: SchemaNotes): void {
  const lines = text.split('\n');
  const header: string[] = [];
  let i = 0;
  for (; i < lines.length && (lines[i].startsWith('--') || lines[i].trim() === ''); i++) header.push(lines[i]);
  const headline = stripNumber(header.find((l) => l.startsWith('--') && l.slice(2).trim())?.slice(2).trim() ?? '');
  const touched = new Set<string>();
  const renames: Array<[string, string]> = [];
  let table: string | null = null; let pending: string[] = []; let last: { cols: string[]; indent: number } | null = null;
  for (; i < lines.length; i++) {
    const { code, comment, at } = split(lines[i]);
    const create = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
    const alter = /ALTER\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
    const rename = /ALTER\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+RENAME\s+TO\s+["`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
    if (rename) renames.push([rename[1].toLowerCase(), rename[2].toLowerCase()]);
    if (create) {
      table = create[1].toLowerCase(); touched.add(table); pending = []; last = null;
      const meaning = comment ?? headline;
      if (meaning) notes.tables.set(table, meaning);
      if (!/\(/.test(code.slice(create.index + create[0].length))) continue;
      const rest = code.slice(code.indexOf('(', create.index) + 1);
      for (const c of columnsOn(rest)) if (comment) noteFor(notes.columns, table).set(c, comment);
      continue;
    }
    if (alter) {
      const t = alter[1].toLowerCase(); touched.add(t);
      const note = comment ?? (pending.length ? pending.join(' ') : null);
      if (note) noteFor(notes.columns, t).set(alter[2].toLowerCase(), note);
      pending = []; continue;
    }
    if (table) {
      if (code.trim() === '' && comment !== null) {
        // Indented past the column it follows: the previous line's comment, continued.
        if (last && at > last.indent) { for (const c of last.cols) noteFor(notes.columns, table).set(c, `${notes.columns.get(table)?.get(c) ?? ''} ${comment}`.trim()); }
        else pending.push(comment);
        continue;
      }
      if (/^\s*\)/.test(code)) { table = null; pending = []; last = null; continue; }
      const cols = columnsOn(code);
      const note = [...pending, ...(comment ? [comment] : [])].join(' ');
      if (cols.length && note) for (const c of cols) noteFor(notes.columns, table).set(c, note);
      last = comment && cols.length ? { cols, indent: code.length - code.trimStart().length } : null; pending = [];
      continue;
    }
    pending = comment !== null && code.trim() === '' ? [...pending, comment] : [];
  }
  headerColumns(header, touched, notes);
  for (const [from, to] of renames) {
    if (notes.tables.has(from)) notes.tables.set(to, notes.tables.get(from) as string);
    for (const [c, n] of notes.columns.get(from) ?? []) noteFor(notes.columns, to).set(c, n);
  }
}

/** `--   name   text` lines of a header (continued by deeper-indented lines) for each table the file touches. */
function headerColumns(header: string[], tables: Set<string>, notes: SchemaNotes): void {
  let current: { name: string; text: string; col: number } | null = null;
  const flush = (): void => { if (current) for (const t of tables) noteFor(notes.columns, t).set(current.name, current.text); current = null; };
  for (const l of header) {
    const m = HEADER_COLUMN.exec(l);
    if (m) { flush(); current = { name: m[2], text: m[4].trim(), col: 2 + m[1].length + m[2].length + m[3].length }; continue; }
    const lead = /^--(\s*)(\S.*)$/.exec(l);
    if (current && lead && 2 + lead[1].length >= current.col - 1) { current.text += ` ${lead[2].trim()}`; continue; }
    flush();
  }
  flush();
}

/** Every note the migrations carry, parsed once per process. */
export function schemaNotes(): SchemaNotes {
  if (cached) return cached;
  const notes: SchemaNotes = { tables: new Map(), columns: new Map() };
  let files: string[] = [];
  try { files = migrationFileNames(); } catch { /* no notes is "(no note)", never a failure */ }
  for (const f of files) {
    try { parseFile(readMigrationFile(f), notes); } catch { /* one unreadable file costs its own notes only */ }
  }
  cached = notes;
  return notes;
}
