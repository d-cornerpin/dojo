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

/** Start times (`lstart`, e.g. "Mon Oct 26 06:00:00 2026") of every live process in a process group. */
export function startTimesOfGroup(pgid: number): string[] {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', 'pgid=,lstart='], { encoding: 'utf8', timeout: 5_000 });
    const starts: string[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m && Number(m[1]) === pgid) starts.push(m[2]);
    }
    return starts;
  } catch { return []; }
}
