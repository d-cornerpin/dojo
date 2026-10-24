// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect (fix round 1) — THE ONE DOOR OF THE READ-ONLY CONNECTION.
//
// `readonly: true` is the real guard: SQLite will not write the file. But a read-only handle
// still accepts statements that change the CONNECTION — `PRAGMA query_only = 0`, `ATTACH`, and
// then `VACUUM INTO '<path>'`, which writes a full copy of the database (every credential
// table included) to any path (measured by the review). SQLite's own `sqlite3_stmt_readonly`
// answers TRUE for a pragma and an ATTACH, so it cannot be the whole test either.
//
// So the connection runs only through this door, whatever the caller: a statement is prepared
// only when its first keyword is SELECT, WITH, VALUES or EXPLAIN (an EXPLAIN only of one of
// those), and the prepared statement is a reader that SQLite calls read-only. `exec`, `pragma`,
// `backup` and `loadExtension` are closed on the handle. The connection's own settings are
// applied before the door shuts.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';

const READS = new Set(['select', 'with', 'values']);
const LEAD = /^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/;

/** The first keyword of a statement, past whitespace and comments, lowercased. */
export function firstKeyword(sql: string): string {
  return (/^[A-Za-z]+/.exec(sql.replace(LEAD, ''))?.[0] ?? '').toLowerCase();
}

/** A statement without its leading `EXPLAIN` / `EXPLAIN QUERY PLAN`, and whether it had one. */
export function stripExplain(sql: string): { explained: boolean; inner: string } {
  const s = sql.replace(LEAD, '');
  const m = /^explain(\s+query\s+plan)?\b/i.exec(s);
  return m ? { explained: true, inner: s.slice(m[0].length) } : { explained: false, inner: s };
}

/** Is this statement, by its words, a read (or an EXPLAIN of one)? */
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

/** Shut the door on a connection already opened `readonly` with its settings applied. */
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
