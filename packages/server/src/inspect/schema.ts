// ════════════════════════════════════════════════════════════════════════════════════════
// EVERY TABLE AND ITS COLUMNS, read live from the read-only connection (so always the box's own).
// A credential table is listed as not readable through dojo_inspect, with no row count; a
// credential column of an allowed table is marked the same way.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { DENIED_TABLES, isDeniedColumn } from './redact.js';

const NOT_READABLE = 'not readable through dojo_inspect';
const FTS_PART = /^(.*)_(data|idx|config|docsize|content)$/;

function tables(db: Database.Database): Array<{ name: string; virtual: boolean }> {
  return (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>)
    .map((t) => ({ name: t.name, virtual: /^CREATE VIRTUAL/i.test(t.sql ?? '') }));
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** What a full-text search table is, or null for an ordinary table. */
function searchPart(name: string, virtualNames: Set<string>): string | null {
  if (virtualNames.has(name)) return 'full-text search index';
  const part = FTS_PART.exec(name);
  return part && virtualNames.has(part[1]) ? `full-text search internals of ${part[1]}` : null;
}

/** Every table with its row count, or one table's columns. */
export function schema(args: { table?: string }, db: Database.Database = getReadOnlyDb()): string {
  const all = tables(db);
  const virtualNames = new Set(all.filter((t) => t.virtual).map((t) => t.name));
  if (!args.table) {
    const lines = all.map(({ name }) => {
      if (DENIED_TABLES.includes(name)) return `${name}: ${NOT_READABLE} (it holds credentials or the owner's private memory)`;
      const n = db.prepare(`SELECT count(*) FROM ${quote(name)}`).pluck().get() as number;
      const fts = searchPart(name, virtualNames);
      return `${name} (${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'})${fts ? `: ${fts}` : ''}`;
    });
    return `${all.length} tables. Ask for one table to see its columns.\n\n${lines.join('\n')}`;
  }
  const t = all.find((x) => x.name.toLowerCase() === args.table?.toLowerCase());
  if (!t) return `No table named ${args.table}. Ask for the schema with no table to list them all.`;
  const cols = db.prepare('SELECT name, type, "notnull" AS nn, pk FROM pragma_table_xinfo(?)').all(t.name) as Array<{ name: string; type: string; nn: number; pk: number }>;
  const denied = DENIED_TABLES.includes(t.name);
  const typeOf = (c: { type: string; nn: number; pk: number }): string => `${c.type || 'ANY'}${c.nn ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}`;
  const nameW = Math.max(...cols.map((c) => c.name.length));
  const rows = cols.map((c) => `${c.name.padEnd(nameW)}  ${typeOf(c)}${isDeniedColumn(c.name, c.type) ? ` (credential: ${NOT_READABLE})` : ''}`);
  const fts = searchPart(t.name, virtualNames);
  const head = denied ? `${t.name}: ${NOT_READABLE}, its rows hold credentials or the owner's private memory` : `${t.name}${fts ? `: ${fts}` : ''}`;
  return `${head}\n\n${rows.join('\n')}`;
}
