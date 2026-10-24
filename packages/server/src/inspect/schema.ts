// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B2 — EVERY TABLE AND COLUMN, WITH WHAT IT MEANS.
//
// The schema is read live from the read-only connection (so it is always the box's own), and
// each table and column carries the meaning its migration wrote down (`schema-notes.ts`).
// A credential table is listed as not readable through dojo_inspect, with no row count; a
// credential column of an allowed table is marked the same way.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { DENIED_TABLES, isDeniedColumn } from './redact.js';
import { schemaNotes } from './schema-notes.js';

const NOT_READABLE = 'not readable through dojo_inspect';
const FTS_PART = /^(.*)_(data|idx|config|docsize|content)$/;

function tables(db: Database.Database): Array<{ name: string; virtual: boolean }> {
  return (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>)
    .map((t) => ({ name: t.name, virtual: /^CREATE VIRTUAL/i.test(t.sql ?? '') }));
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** One table's meaning, or what it is when no migration wrote one. */
function meaning(name: string, virtualNames: Set<string>): string {
  const note = schemaNotes().tables.get(name.toLowerCase());
  if (note) return note;
  if (virtualNames.has(name)) return 'full-text search index';
  const part = FTS_PART.exec(name);
  if (part && virtualNames.has(part[1])) return `full-text search internals of ${part[1]}`;
  return '(no description)';
}

/** Every table with its row count and meaning, or one table's columns. */
export function schema(args: { table?: string }, db: Database.Database = getReadOnlyDb()): string {
  const all = tables(db);
  const virtualNames = new Set(all.filter((t) => t.virtual).map((t) => t.name));
  if (!args.table) {
    const lines = all.map(({ name }) => {
      if (DENIED_TABLES.includes(name)) return `${name} — ${NOT_READABLE} (it holds credentials or the owner's private memory)`;
      const n = db.prepare(`SELECT count(*) FROM ${quote(name)}`).pluck().get() as number;
      return `${name} (${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}) — ${meaning(name, virtualNames)}`;
    });
    return `${all.length} tables. Ask for one table to see its columns and what each means.\n\n${lines.join('\n')}`;
  }
  const t = all.find((x) => x.name.toLowerCase() === args.table?.toLowerCase());
  if (!t) return `No table named ${args.table}. Ask for the schema with no table to list them all.`;
  const cols = db.prepare('SELECT name, type, "notnull" AS nn, pk FROM pragma_table_xinfo(?)').all(t.name) as Array<{ name: string; type: string; nn: number; pk: number }>;
  const notes = schemaNotes().columns.get(t.name.toLowerCase());
  const denied = DENIED_TABLES.includes(t.name);
  const typeOf = (c: { type: string; nn: number; pk: number }): string => `${c.type || 'ANY'}${c.nn ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}`;
  const nameW = Math.max(...cols.map((c) => c.name.length));
  const typeW = Math.max(...cols.map((c) => typeOf(c).length));
  const rows = cols.map((c) => {
    const credential = isDeniedColumn(c.name, c.type) ? ` (credential: ${NOT_READABLE})` : '';
    return `${c.name.padEnd(nameW)}  ${typeOf(c).padEnd(typeW)}  ${notes?.get(c.name.toLowerCase()) ?? '(no description)'}${credential}`;
  });
  const head = `${t.name} — ${denied ? `${NOT_READABLE}: its rows hold credentials or the owner's private memory` : meaning(t.name, virtualNames)}`;
  return `${head}\n\n${rows.join('\n')}`;
}
