// ════════════════════════════════════════════════════════════════════════════════════════
// classifyDojoLine — THE SHELL DOOR FINDS THE COMMAND ACTUALLY RUN, whatever launched it.
//
// Requirements pinned here (each row failed on the code before this change):
//   • a wrapper option that takes its value as a separate word has that value consumed in its
//     long form as well as its short form, for timeout, nice, sudo and env;
//   • a wrapper option the door does not know never turns a line into "not a database command":
//     a line that names the database or log is classified as touching it;
//   • the other launchers (xargs, setsid, stdbuf, ionice, exec, a shell run with -c) are read through;
//   • the change only tightens: lines that were null for a good reason stay null.
// All paths are invented; nothing is executed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { classifyDojoLine, type DojoLineClass } from '../dojo-redirect.js';

const DB = '~/.dojo/data/dojo.db';
const CASES: Array<{ line: string; want: DojoLineClass | null; why: string }> = [
  // ── long-form options that take a separate value ──
  { line: `timeout --kill-after 5 30 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'timeout --kill-after VALUE' },
  { line: `timeout --signal KILL 30 sqlite3 ${DB} "delete from agents"`, want: 'repair', why: 'timeout --signal VALUE then the duration' },
  { line: `timeout --kill-after=5 30 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'the = form' },
  { line: `nice --adjustment 10 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'nice --adjustment VALUE' },
  { line: `nice --adjustment=10 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'nice --adjustment=VALUE (already worked)' },
  { line: `sudo --user svc sqlite3 ${DB} "select 1"`, want: 'sql', why: 'sudo --user VALUE' },
  { line: `sudo --group svc --chdir /tmp sqlite3 ${DB} ".tables"`, want: 'schema', why: 'sudo --group and --chdir take values' },
  { line: `env --unset FOO sqlite3 ${DB} "select 1"`, want: 'sql', why: 'env --unset VALUE' },
  { line: `env --chdir /tmp rm ${DB}-wal`, want: 'write', why: 'env --chdir VALUE before a delete' },
  { line: `env -C /tmp sqlite3 ${DB} "select 1"`, want: 'sql', why: 'env -C DIR short form' },
  { line: `env -S "sqlite3 ${DB} 'select 1'"`, want: 'sql', why: 'env -S carries a whole command string' },
  { line: `sudo -E -n sqlite3 ${DB} "select 1"`, want: 'sql', why: 'known flags without values' },
  { line: `time -p sqlite3 ${DB} "select 1"`, want: 'sql', why: 'time -p is time\'s own flag' },
  { line: `/usr/bin/timeout --kill-after 5 30 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'a path-qualified wrapper' },
  { line: `timeout -- 10 sqlite3 ${DB} "select 1"`, want: 'sql', why: '-- ends the options' },
  // ── an option the door does not know: conservative, never null ──
  { line: `timeout --made-up-option 30 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'unknown timeout option, program still found' },
  { line: `sudo --made-up-option sqlite3 ${DB} "delete from agents"`, want: 'repair', why: 'unknown sudo option, write statement still seen' },
  { line: `timeout --made-up-option 30 rm ${DB}`, want: 'write', why: 'unknown option before a delete' },
  { line: `nice --made-up 5 mystery-tool ${DB}`, want: 'sql', why: 'unknown option and unknown program, names the database: counts as touching it' },
  { line: 'nice --made-up 5 mystery-tool ~/.dojo/logs/dojo.log', want: 'logs', why: 'names the log' },
  { line: 'nice --made-up 5 ls /tmp', want: null, why: 'names neither: nothing to guard' },
  // ── other launchers ──
  { line: `xargs sqlite3 ${DB} "select 1"`, want: 'sql', why: 'xargs' },
  { line: `echo x | xargs -n 1 sqlite3 ${DB}`, want: 'sql', why: 'xargs -n VALUE after a pipe' },
  { line: `xargs -I {} rm ${DB}-wal`, want: 'write', why: 'xargs -I VALUE' },
  { line: `xargs --max-args 1 sqlite3 ${DB}`, want: 'sql', why: 'xargs long option with a value' },
  { line: `setsid sqlite3 ${DB} "select 1"`, want: 'sql', why: 'setsid' },
  { line: `setsid -f rm ${DB}`, want: 'write', why: 'setsid -f' },
  { line: `stdbuf -oL sqlite3 ${DB} "select 1"`, want: 'sql', why: 'stdbuf attached value' },
  { line: `stdbuf -o L -e 0 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'stdbuf separate values' },
  { line: `ionice -c 3 sqlite3 ${DB} "select 1"`, want: 'sql', why: 'ionice -c VALUE' },
  { line: `ionice --class idle --classdata 0 rm ${DB}`, want: 'write', why: 'ionice long options' },
  { line: `exec sqlite3 ${DB} "select 1"`, want: 'sql', why: 'exec' },
  { line: `exec -a name sqlite3 ${DB} "select 1"`, want: 'sql', why: 'exec -a VALUE' },
  { line: `bash -c "sqlite3 ${DB} 'select 1'"`, want: 'sql', why: 'a shell run with -c' },
  { line: `sh -c 'sqlite3 ${DB} "delete from agents"'`, want: 'repair', why: 'sh -c with a write statement' },
  { line: `bash -lc "rm ${DB}-wal"`, want: 'write', why: 'a -lc cluster' },
  { line: `zsh -c "tail -n 5 ~/.dojo/logs/dojo.log"`, want: 'logs', why: 'zsh -c on the log' },
  { line: `timeout 10 bash -c "sqlite3 ${DB} .tables"`, want: 'schema', why: 'a wrapper around a shell -c' },
  { line: `sudo -u svc bash -c "cat ${DB}"`, want: 'sql', why: 'wrapper, shell, reader' },
  // ── unchanged ──
  { line: `xargs ls ${DB}`, want: null, why: 'a look at the file itself passes through a launcher' },
  { line: `bash -c "ls ${DB}"`, want: null, why: 'same, inside a shell string' },
  { line: 'bash script.sh', want: null, why: 'a script file is beyond the door (habit guard)' },
  { line: 'xargs echo hello', want: null, why: 'unrelated' },
];

describe('classifyDojoLine — every launcher and option form', () => {
  it.each(CASES)('$line', ({ line, want, why }) => {
    expect(classifyDojoLine(line), why).toBe(want);
  });
});
