// ════════════════════════════════════════════════════════════════════════════════════════
// dojoDoorVerdict, formerly classifyDojoLine: THE SHELL-REDIRECT CLASSIFIER, pinned line for line.
//
// FIELD FIX 3 (v35-field-fix-3): THE DOOR IS NOW AN ALLOWLIST. The classes this table used to pin
// ('sql', 'schema', 'repair', 'write', 'logs') belonged to a denylist that tried to spot what a line
// does. A line that refers to the live database or the Dojo data folder now runs only as one plain
// sqlite3 read (see the header of dojo-redirect.ts), so every row below keeps its line and now pins
// the main agent's verdict from `dojoDoorVerdict`: 'untouched' (the line refers to neither),
// 'allowed' (the exact shape) or 'refused' (anything else that refers to them). A metadata look (ls, stat, du, wc -c, lsof, fuser,
// file, shasum) with plain words is the one other allowed shape. Seeing through a
// launcher no longer matters: a launcher is not the exact shape, so the line is refused.
//
// WHAT THIS IS FOR: the broker points the main agent at dojo_inspect instead of letting it
// shell its own history, but it can only REFUSE, never permit. The whole decision rests on a
// pure classifier over the command line: does it touch the Dojo's own database or log, and in
// what way ('write' | 'repair' | 'schema' | 'sql' | 'logs' | null): and it had no test of its
// own (searched every *.test.ts on v35; none referenced classifyDojoLine, redirectDojoQuestion
// or this file). A regex heuristic that quietly mis-classifies would either refuse a real
// diagnostic or, worse, let a write through undetected; the table below pins the boundary on
// both sides, and each row's reason is its own failure message.
//
// ── WHY THE IMPORT IS BARE, NO MOCKS ──
// classifyDojoLine is a pure function of the string: no database, no home, no network. The module
// it lives in pulls in inspect/grant.js and config/platform.js at import, but only
// redirectDojoQuestion uses them, and db/connection.js opens its database LAZILY in getDb() -
// nothing in that subgraph runs at collection. So the import loads on its own; a fixture home or
// a vi.mock would be ceremony the pure subject does not need.
//
// ── THE SHAPES DELIBERATELY NOT IN THIS TABLE ──
// Quoted multi-statement scripts and interpreters (python/node -c, a subshell, a variable) are
// absent on purpose: the classifier is a heuristic over the visible line and cannot see through
// them, and that is a separate design question (the SCOPE note at the top of dojo-redirect.ts).
// Only the plain single-statement forms the habit guard is for are pinned here.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { dojoDoorVerdict, type DoorOutcome } from '../dojo-redirect.js';

// Each row: the command line, the class the classifier must return, and the reason it is there -
// the reason doubles as the assertion's failure message, so a surprise names the case it surprised.
const CASES: Array<{ line: string; want: DoorOutcome; why: string }> = [
  // ── null: it only LOOKS at the file, or not at the dojo's at all ──
  { line: 'ls ~/.dojo/data', want: 'allowed', why: 'ls only looks at the directory (a metadata look), which no view answers' },
  { line: 'ls dojo.db', want: 'allowed', why: 'a look at the file itself (a metadata look), which no view answers' },
  { line: 'grep foo mydojo.db', want: 'untouched', why: 'a different file name that merely ends in dojo.db: the boundary prefix excludes it' },

  // ── 'sql': a read of the live database, or reading it out ──
  { line: 'cat dojo.db', want: 'refused', why: 'cat reads the database out' },
  { line: 'cat dojo.db | grep x', want: 'refused', why: 'the left pipe segment reads the db; the right (grep x) touches nothing' },
  { line: 'cp dojo.db backup.db', want: 'refused', why: 'reading the db out: cp is a content reader and the destination is not the db' },
  { line: 'dd if=dojo.db of=x', want: 'refused', why: 'dd reads the db in (if=) into another file' },
  { line: 'sqlite3 ~/.dojo/data/dojo.db "select 1"', want: 'allowed', why: 'the exact shape: sqlite3, the literal path, one quoted read (select 1: this pure test has no schema, and a statement the server cannot compile is refused)' },

  // ── 'schema': a schema look, not a data read ──
  { line: 'sqlite3 dojo.db ".schema"', want: 'refused', why: 'a .schema dot-command is a schema look' },
  { line: 'sqlite3 dojo.db "pragma table_info(agents)"', want: 'refused', why: 'pragma table_info is a schema look, not a write' },

  // ── 'repair': a changing statement through sqlite3 ──
  { line: 'sqlite3 dojo.db "update agents set name=1"', want: 'refused', why: 'an update ... set is a repair statement, not a write' },

  // ── 'logs': a read of the platform log ──
  { line: 'cat dojo.log', want: 'untouched', why: 'the platform log, read through a content reader' },
  { line: 'tail -f ~/.dojo/dojo.log', want: 'untouched', why: 'the log by its full path, read through a content reader' },

  // ── 'write': a file-level write, or a write into the live database ──
  { line: 'rm dojo.db', want: 'refused', why: 'deleting the database file' },
  { line: 'sudo rm dojo.db-wal', want: 'refused', why: 'a -wal sibling, behind a sudo prefix the classifier strips' },
  { line: 'mv dojo.db /tmp/x', want: 'refused', why: 'moving the database away' },
  { line: 'mv x dojo.db', want: 'refused', why: 'the db is the destination: a write either way' },
  { line: 'cp backup.db dojo.db', want: 'refused', why: 'writing over the db: the last operand names it' },
  { line: 'echo hi > dojo.db', want: 'refused', why: 'a shell redirect into the database file' },

  // ── 'write' by rank: the strongest segment wins ──
  { line: 'cat dojo.db | rm dojo.db', want: 'refused', why: 'the strongest segment wins: a read (sql) then a delete (write)' },

  // ── find: a metadata look while it runs, writes and deletes nothing ──
  { line: 'find ~/.dojo -name "*.md"', want: 'allowed', why: 'find with a quoted name pattern lists file names only' },
  { line: 'find ~/.dojo -type f', want: 'allowed', why: 'find by type lists file names only' },
  { line: 'find ~/.dojo/data -name dojo.db -ls', want: 'allowed', why: '-ls prints file facts, not contents' },
  { line: 'find ~/.dojo -name x -delete', want: 'refused', why: '-delete removes files' },
  { line: 'find ~/.dojo -exec cat {} +', want: 'refused', why: '-exec runs a program on each file' },
  { line: 'find ~/.dojo -name x -execdir cat {} ;', want: 'refused', why: '-execdir runs a program' },
  { line: 'find ~/.dojo -ok cat {} ;', want: 'refused', why: '-ok runs a program' },
  { line: 'find ~/.dojo -fprint /tmp/list', want: 'refused', why: '-fprint writes a file' },
  { line: 'find -files0-from ~/.dojo/data/dojo.db', want: 'refused', why: '-files0-from reads a file and prints its bytes as names' },
  { line: 'find ~/.dojo -name *.md', want: 'refused', why: 'an unquoted pattern the shell expands' },
  { line: 'find ~/.dojo -name "*.db" | xargs strings', want: 'refused', why: 'a look piped onward is no longer a look' },
];

describe('dojoDoorVerdict: the shell-redirect classifier', () => {
  it.each(CASES)('$line', ({ line, want, why }) => {
    expect(dojoDoorVerdict(line, 'main').outcome, why).toBe(want);
  });
});

describe('dojoDoorVerdict: find for a worker', () => {
  it('a worker is refused even a plain find', () => {
    expect(dojoDoorVerdict('find ~/.dojo -type f', 'worker').outcome).toBe('refused');
  });
});
