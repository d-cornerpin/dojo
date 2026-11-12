// Process identity (start time and command) so boot never signals a reused pid (toolbox-ledger.ts).
// One fixed program (`ps`), argv form, no shell; the only input is an integer process id.
import { execFile, execFileSync } from 'node:child_process';

/** Start time and command of a live pid; null when it is not running. */
export function identityOfPid(pid: number): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim();
    return out === '' ? null : out;
  } catch { return null; }
}

function parseMembers(out: string, pgid: number): string[] {
  const members: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && Number(m[2]) === pgid) members.push(`${m[1]} ${m[3]}`);
  }
  return members;
}

const MEMBER_COLUMNS = ['-A', '-o', 'pid=,pgid=,lstart='];

/** Each live member of a process group as "pid lstart" (e.g. "5151 Mon Oct 26 06:00:00 2026"). */
export function membersOfGroup(pgid: number): string[] {
  try {
    return parseMembers(execFileSync('/bin/ps', MEMBER_COLUMNS, { encoding: 'utf8', timeout: 5_000 }), pgid);
  } catch { return []; }
}

/** Same as `membersOfGroup`, without holding the event loop while `ps` runs. */
export function membersOfGroupAsync(pgid: number): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', MEMBER_COLUMNS, { encoding: 'utf8', timeout: 5_000 }, (err, out) => resolve(err ? [] : parseMembers(out, pgid)));
    } catch { resolve([]); }
  });
}

/** Every process's command line, one per line (fixed `ps`, no agent input); '' if unreadable or aborted. */
export function processCommandsAsync(signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8', signal, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
    } catch { resolve(''); }
  });
}
