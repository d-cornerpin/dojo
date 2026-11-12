// The one door of the read-only connection. `readonly` stops file writes, but the handle still accepts
// PRAGMA query_only = 0, ATTACH, then VACUUM INTO (a full database copy to any path), and SQLite's
// stmt_readonly says true for a pragma or ATTACH. So only a SELECT, WITH, VALUES or EXPLAIN of one that
// SQLite marks a read-only reader is prepared, and exec, pragma, backup and loadExtension are closed.

import type Database from 'better-sqlite3';

const READS = new Set(['select', 'with', 'values']);
const LEAD = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/;

/** The first keyword of a statement, past whitespace and comments, lowercased. */
export function firstKeyword(sql: string): string {
  return (/^[A-Za-z]+/.exec(sql.replace(LEAD, ''))?.[0] ?? '').toLowerCase();
}

export function stripExplain(sql: string): { explained: boolean; inner: string } {
  const s = sql.replace(LEAD, '');
  const m = /^explain(\s+query\s+plan)?\b/i.exec(s);
  return m ? { explained: true, inner: s.slice(m[0].length) } : { explained: false, inner: s };
}

export function isReadStatement(sql: string): boolean {
  const { inner } = stripExplain(sql);
  return READS.has(firstKeyword(inner));
}

class ReadOnlyDoorError extends Error {
  readonly code = 'DOJO_READ_ONLY_DOOR';
}

const refuse = (what: string): never => {
  throw new ReadOnlyDoorError(`${what} does not run on dojo_inspect's read-only connection: only a read does (SELECT, WITH, VALUES, or EXPLAIN of one).`);
};

/** Shut the door on a connection opened `readonly` whose settings are already applied. */
export function guardReadOnly(db: Database.Database): Database.Database {
  const prepare = db.prepare.bind(db);
  const door = ((source: string) => {
    if (!isReadStatement(source)) refuse('That statement');
    const stmt = prepare(source);
    if (!stmt.reader || !stmt.readonly) refuse('That statement');
    return stmt;
  }) as Database.Database['prepare'];
  Object.assign(db, {
    prepare: door,
    exec: () => refuse('exec'),
    pragma: () => refuse('A pragma'),
    backup: () => refuse('A backup'),
    loadExtension: () => refuse('An extension'),
  });
  return db;
}
