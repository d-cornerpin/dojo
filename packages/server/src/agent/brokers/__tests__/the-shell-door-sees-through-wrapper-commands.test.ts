// ════════════════════════════════════════════════════════════════════════════════════════
// classifyDojoLine — THE SHELL DOOR SEES THROUGH WRAPPER COMMANDS.
//
// An agent bounds a shell call with `timeout 10 …`, lowers its priority with `nice -n 10 …`,
// runs it as another user or with a trimmed environment. The classifier used to drop the
// wrapper word alone, so the program it read was the wrapper's OWN argument (`10`, `-n`,
// `-u`, `-i`) — no program list matched, the line classed as null, and both guards skipped
// it: a holder lost the redirect to dojo_inspect, and a write like
// `timeout 10 sqlite3 dojo.db "delete from x"` slipped past the refusal entirely.
// The wrappers' own arguments now come off with the wrapper, so the program underneath is
// read; each wrapper shape is pinned below, plus the plain forms that already worked.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { classifyDojoLine, type DojoLineClass } from '../dojo-redirect.js';

// Each row: the command line, the class the classifier must return, and the reason it is there —
// the reason doubles as the assertion's failure message, so a surprise names the case it surprised.
const CASES: Array<{ line: string; want: DojoLineClass | null; why: string }> = [
  // ── timeout: the wrapper, its flags, and the duration all come off ──
  { line: 'timeout 10 sqlite3 ~/.dojo/data/dojo.db "select 1"', want: 'sql', why: 'a plain seconds duration must not be read as the program' },
  { line: 'timeout 10s sqlite3 ~/.dojo/data/dojo.db "select 1"', want: 'sql', why: 'a duration with a unit suffix is still the duration, not the program' },
  { line: 'timeout -k 5 30 sqlite3 ~/.dojo/data/dojo.db ".tables"', want: 'schema', why: '-k takes a kill-after value of its own; the duration after it is still stripped before the .tables schema look' },

  // ── nice, sudo, env: each consumes its own flags (and their values) before the program ──
  { line: 'nice -n 10 sqlite3 ~/.dojo/data/dojo.db "select 1"', want: 'sql', why: '-n and its adjustment value belong to nice, not to the read' },
  { line: 'sudo -u dojo sqlite3 ~/.dojo/data/dojo.db "select 1"', want: 'sql', why: '-u and its user name belong to sudo' },
  { line: 'env -i sqlite3 dojo.db "select 1"', want: 'sql', why: "-i is env's flag, not an operand" },
  { line: 'env FOO=1 timeout 5 sqlite3 dojo.db "delete from agents"', want: 'repair', why: 'env strips its NAME=value assignment and the nested timeout strips its duration before the write statement is read' },

  // ── the other classes, through a wrapper ──
  { line: 'timeout 10 tail -n 20 ~/.dojo/logs/dojo.log', want: 'logs', why: 'a wrapped tail on the platform log still asks the log a question' },
  { line: 'timeout 10 rm ~/.dojo/data/dojo.db-wal', want: 'write', why: 'the common bounded call must not carry a delete of the -wal sibling past the write guard' },

  // ── unchanged: what already worked keeps working, and nulls stay null ──
  { line: 'time sqlite3 dojo.db "select 1"', want: 'sql', why: 'time takes no arguments; it already worked and must keep working' },
  { line: 'ls -l ~/.dojo/data/dojo.db', want: null, why: 'a look at the file itself passes, wrapper or not' },
  { line: 'timeout 10 ls ~/.dojo/data/dojo.db', want: null, why: 'the same look, wrapped: seeing through timeout must not turn ls into a content reader' },
];

describe('classifyDojoLine — commands wrapped in timeout/nice/sudo/env', () => {
  it.each(CASES)('$line', ({ line, want, why }) => {
    expect(classifyDojoLine(line), why).toBe(want);
  });
});
