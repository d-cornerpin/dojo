// Who a running process is: its start time and command, for the boot step that must not
// signal a process id some unrelated program has since reused (agent/effects/toolbox-ledger.ts).
// One fixed program (`ps`), argv form, no shell; the only input is an integer process id.
import { execFileSync } from 'node:child_process';

/** Start time and command of a live pid; null when it is not running. */
export function identityOfPid(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim();
    return out === '' ? null : out;
  } catch { return null; }
}
