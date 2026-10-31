import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { deadInstallWorkDirs, pidAlive } from './install-tree.js';

const logger = createLogger('update-leftovers');

/** Temp files the marker writer leaves when a kill lands between its temp write and its
 *  rename (`update-state.ts`'s `tempPath`). The record itself and its `.lock` cannot match. */
const UPDATE_STATE_TMP = /^update-state\.json\.(\d+)\.(?:.+\.)?tmp$/;

interface Writer { pid: number; ppid: number; command: string; dir: string }

/** The folder (of `dirs`) a path lies in, or null. Both the given and the real spelling count. */
function dirOf(p: string, dirs: string[]): string | null {
  return dirs.find((d) => p === d || p.startsWith(d + path.sep)) ?? null;
}

/**
 * The processes working inside any of `dirs` (dead installers' work dirs): a process whose command
 * line names a path inside one (the `cp -Rc` of the dependency clone, `unzip`), or whose current
 * folder is inside one (`npm install` in the staged tree). Both spellings of each dir are compared
 * (a temp folder may sit behind a symlink). Anything unreadable counts as none found.
 */
export function writersInto(dirs: string[]): Writer[] {
  if (dirs.length === 0) return [];
  const all = [...new Set(dirs.flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch { return [d]; } }))];
  const found = new Map<number, Writer>();
  const info = new Map<number, { ppid: number; command: string }>();
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      info.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
      const dir = all.find((d) => m[3].includes(d + path.sep) || m[3].endsWith(d));
      if (dir) found.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3], dir });
    }
  } catch { /* no ps: nothing found */ }
  try {
    let pid = 0;
    for (const line of execFileSync('lsof', ['-nP', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0) {
        const dir = dirOf(line.slice(1), all);
        if (dir && !found.has(pid)) found.set(pid, { pid, ppid: info.get(pid)?.ppid ?? 0, command: info.get(pid)?.command ?? '', dir });
      }
    }
  } catch { /* no lsof, or a partial listing: what was found stands */ }
  found.delete(process.pid);
  return [...found.values()];
}

/** Gone, or a zombie nobody has reaped yet (it holds nothing). `kill -0` first; `ps` only if it answers. */
function exited(pid: number): boolean {
  if (!pidAlive(pid)) return true;
  try { return /^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return true; }
}

/** Is `pid` still working in `dir`? A pid reused by another program during the wait is not. */
function stillWorkingIn(pid: number, dir: string): boolean {
  return writersInto([dir]).some((w) => w.pid === pid);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stops the orphaned writers in `dirs` and WAITS until each has really exited. A SIGKILL takes effect
 * only when the process leaves the kernel call it is in, and `cp -Rc` is one `clonefile` of the whole
 * tree: the clone can land after the kill, so a folder removed before the writer is gone is filled
 * again ("directory not empty"). The wait is on the exit itself: no cap, but it backs off, it says so
 * when it has waited long, it ends if the pid turns out to be another program, and a process that
 * cannot be killed (another user's: EPERM) is never waited on. Only true orphans (re-parented to
 * launchd, pid 1) are killed; the owner's own shell or editor that merely sits in the folder is left
 * alone. Returns the dirs that must be left for the next start.
 */
async function stopWriters(dirs: string[]): Promise<Set<string>> {
  const leave = new Set<string>();
  const waiting: Writer[] = [];
  for (const w of writersInto(dirs)) {
    if (w.ppid !== 1) {
      logger.info('A process is working in a dead installer\'s work dir but is not its orphan; left alone', { pid: w.pid, command: w.command.slice(0, 200) });
      continue;
    }
    try {
      process.kill(w.pid, 'SIGKILL');
      logger.info('Stopped a process still writing into a dead installer\'s work dir', { pid: w.pid });
      waiting.push(w);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') continue; // already gone
      logger.warn('Could not stop a process writing into a dead installer\'s work dir; the folder is left for the next start', { pid: w.pid, code, command: w.command.slice(0, 200) });
      leave.add(w.dir);
    }
  }
  const t0 = Date.now();
  let delay = 25;
  let nextNotice = 10_000;
  let live = waiting;
  while (live.length > 0) {
    live = live.filter((w) => !exited(w.pid) && stillWorkingIn(w.pid, w.dir));
    if (live.length === 0) break;
    if (Date.now() - t0 >= nextNotice) {
      logger.warn('Still waiting for a stopped process to leave a dead installer\'s work dir', { pids: live.map((w) => w.pid), waitedMs: Date.now() - t0 });
      nextNotice += 300_000;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 1000);
  }
  return leave;
}

/**
 * EVERY start, before anything else: remove the leftovers of an update that was killed
 * mid-flight — work dirs whose installer process is gone (a live installer's own staging is
 * never named here, `deadInstallWorkDirs` keeps that), and marker temp files stranded beside
 * `update-state.json` whose writer process is gone. A removal that fails gets one log line of its
 * own and is simply tried again at the next start. The live `platform` folder and the current
 * `update-state.json` can never match either pattern.
 */
export async function cleanUpdateLeftovers(dojoDir: string): Promise<{ deleted: string[]; failed: string[] }> {
  const workDirs = deadInstallWorkDirs(dojoDir);
  let tmps: string[] = [];
  try { tmps = fs.readdirSync(dojoDir).filter((n) => {
      // Only a temp file whose writer is dead: the watchdog records transitions at boot and
      // must not lose its temp file between its write and its rename.
      const m = UPDATE_STATE_TMP.exec(n);
      return m !== null && !pidAlive(Number(m[1]));
    }).map((n) => path.join(dojoDir, n)); } catch { /* nothing to name */ }
  const leftovers = [...workDirs, ...tmps];
  const names = leftovers.map((p) => path.basename(p));
  const deleted: string[] = [];
  const failed: string[] = [];
  const removeOne = (p: string): Promise<void> => new Promise((resolve, reject) => {
    // Hand `fs.rm` the callback IT reports through: its promise-less form here returns
    // `undefined` and deletes nothing while rimraf dies behind — a sweep on that would
    // log a clean-up that never happened. The callback is the contract it keeps.
    fs.rm(p, { recursive: true, force: true }, (err) => (err ? reject(err) : resolve()));
  });
  // The writers go first (only work dirs can have one). A SIGKILLed server leaves its `cp` running,
  // and removing a folder under a live writer is what left it behind for good.
  let leave = await stopWriters(workDirs);
  const removeStopped = async (p: string): Promise<void> => {
    if (leave.has(p)) throw new Error('a process that could not be stopped is still working in it');
    try { await removeOne(p); } catch {
      if (!fs.existsSync(p)) return;
      leave = new Set([...leave, ...(await stopWriters(workDirs))]);
      if (leave.has(p)) throw new Error('a process that could not be stopped is still working in it');
      await removeOne(p);
    }
  };
  const results = await Promise.allSettled(leftovers.map((p) => removeStopped(p)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      deleted.push(names[i]);
    } else {
      failed.push(names[i]);
      logger.warn('Update leftover could not be removed; it will be tried again at the next start', { item: names[i], error: String(r.reason) });
    }
  }
  if (deleted.length > 0) logger.info('Removed leftovers of an interrupted update', { deleted });
  return { deleted, failed };
}
