// ════════════════════════════════════════════════════════════════════════════════════════
// dojoDoorVerdict, formerly classifyDojoLine: THE SHELL DOOR FINDS THE COMMAND ACTUALLY RUN, whatever launched it.
//
// FIELD FIX 3 (v35-field-fix-3): THE DOOR IS NOW AN ALLOWLIST. The classes this table used to pin
// ('sql', 'schema', 'repair', 'write', 'logs') belonged to a denylist that tried to spot what a line
// does. A line that refers to the live database or the Dojo data folder now runs only as one plain
// sqlite3 read (see the header of dojo-redirect.ts), so every row below keeps its line and now pins
// the Healer's verdict from `dojoDoorVerdict` (the main agent's lines are allowed): 'untouched' (the line refers to neither),
// 'allowed' (the exact shape) or 'refused' (anything else that refers to them). Seeing through a
// launcher no longer matters: a launcher is not the exact shape, so the line is refused.
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
import { dojoDoorVerdict, type DoorOutcome } from '../dojo-redirect.js';

const DB = '~/.dojo/data/dojo.db';
const CASES: Array<{ line: string; want: DoorOutcome; why: string }> = [
  // ── long-form options that take a separate value ──
  { line: `timeout --kill-after 5 30 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'timeout --kill-after VALUE' },
  { line: `timeout --signal KILL 30 sqlite3 ${DB} "delete from agents"`, want: 'refused', why: 'timeout --signal VALUE then the duration' },
  { line: `timeout --kill-after=5 30 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'the = form' },
  { line: `nice --adjustment 10 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'nice --adjustment VALUE' },
  { line: `nice --adjustment=10 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'nice --adjustment=VALUE (already worked)' },
  { line: `sudo --user svc sqlite3 ${DB} "select 1"`, want: 'refused', why: 'sudo --user VALUE' },
  { line: `sudo --group svc --chdir /tmp sqlite3 ${DB} ".tables"`, want: 'refused', why: 'sudo --group and --chdir take values' },
  { line: `env --unset FOO sqlite3 ${DB} "select 1"`, want: 'refused', why: 'env --unset VALUE' },
  { line: `env --chdir /tmp rm ${DB}-wal`, want: 'refused', why: 'env --chdir VALUE before a delete' },
  { line: `env -C /tmp sqlite3 ${DB} "select 1"`, want: 'refused', why: 'env -C DIR short form' },
  { line: `env -S "sqlite3 ${DB} 'select 1'"`, want: 'refused', why: 'env -S carries a whole command string' },
  { line: `sudo -E -n sqlite3 ${DB} "select 1"`, want: 'refused', why: 'known flags without values' },
  { line: `time -p sqlite3 ${DB} "select 1"`, want: 'refused', why: 'time -p is time\'s own flag' },
  { line: `/usr/bin/timeout --kill-after 5 30 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'a path-qualified wrapper' },
  { line: `timeout -- 10 sqlite3 ${DB} "select 1"`, want: 'refused', why: '-- ends the options' },
  // ── an option the door does not know: conservative, never null ──
  { line: `timeout --made-up-option 30 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'unknown timeout option, program still found' },
  { line: `sudo --made-up-option sqlite3 ${DB} "delete from agents"`, want: 'refused', why: 'unknown sudo option, write statement still seen' },
  { line: `timeout --made-up-option 30 rm ${DB}`, want: 'refused', why: 'unknown option before a delete' },
  { line: `nice --made-up 5 mystery-tool ${DB}`, want: 'refused', why: 'unknown option and unknown program, names the database: counts as touching it' },
  { line: 'nice --made-up 5 mystery-tool ~/.dojo/logs/dojo.log', want: 'untouched', why: 'names the log' },
  { line: 'nice --made-up 5 ls /tmp', want: 'untouched', why: 'names neither: nothing to guard' },
  // ── other launchers ──
  { line: `xargs sqlite3 ${DB} "select 1"`, want: 'refused', why: 'xargs' },
  { line: `echo x | xargs -n 1 sqlite3 ${DB}`, want: 'refused', why: 'xargs -n VALUE after a pipe' },
  { line: `xargs -I {} rm ${DB}-wal`, want: 'refused', why: 'xargs -I VALUE' },
  { line: `xargs --max-args 1 sqlite3 ${DB}`, want: 'refused', why: 'xargs long option with a value' },
  { line: `setsid sqlite3 ${DB} "select 1"`, want: 'refused', why: 'setsid' },
  { line: `setsid -f rm ${DB}`, want: 'refused', why: 'setsid -f' },
  { line: `stdbuf -oL sqlite3 ${DB} "select 1"`, want: 'refused', why: 'stdbuf attached value' },
  { line: `stdbuf -o L -e 0 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'stdbuf separate values' },
  { line: `ionice -c 3 sqlite3 ${DB} "select 1"`, want: 'refused', why: 'ionice -c VALUE' },
  { line: `ionice --class idle --classdata 0 rm ${DB}`, want: 'refused', why: 'ionice long options' },
  { line: `exec sqlite3 ${DB} "select 1"`, want: 'refused', why: 'exec' },
  { line: `exec -a name sqlite3 ${DB} "select 1"`, want: 'refused', why: 'exec -a VALUE' },
  { line: `bash -c "sqlite3 ${DB} 'select 1'"`, want: 'refused', why: 'a shell run with -c' },
  { line: `sh -c 'sqlite3 ${DB} "delete from agents"'`, want: 'refused', why: 'sh -c with a write statement' },
  { line: `bash -lc "rm ${DB}-wal"`, want: 'refused', why: 'a -lc cluster' },
  { line: `zsh -c "tail -n 5 ~/.dojo/logs/dojo.log"`, want: 'untouched', why: 'zsh -c on the log' },
  { line: `timeout 10 bash -c "sqlite3 ${DB} .tables"`, want: 'refused', why: 'a wrapper around a shell -c' },
  { line: `sudo -u svc bash -c "cat ${DB}"`, want: 'refused', why: 'wrapper, shell, reader' },
  // ── unchanged ──
  { line: `xargs ls ${DB}`, want: 'refused', why: 'a look at the file through a launcher is not the exact shape' },
  { line: `bash -c "ls ${DB}"`, want: 'refused', why: 'a shell string is not the exact shape' },
  { line: 'bash script.sh', want: 'untouched', why: 'a script file is beyond the door (habit guard)' },
  { line: 'xargs echo hello', want: 'untouched', why: 'unrelated' },
];

describe('dojoDoorVerdict: every launcher and option form', () => {
  it.each(CASES)('$line', ({ line, want, why }) => {
    expect(dojoDoorVerdict(line, 'healer').outcome, why).toBe(want);
  });
});
