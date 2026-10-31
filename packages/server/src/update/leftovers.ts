import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../logger.js';
import { deadInstallWorkDirs, pidAlive } from './install-tree.js';

const logger = createLogger('update-leftovers');

/** Temp files the marker writer leaves when a kill lands between its temp write and its
 *  rename (`update-state.ts`'s `tempPath`). The record itself and its `.lock` cannot match. */
const UPDATE_STATE_TMP = /^update-state\.json\.(\d+)\.(?:.+\.)?tmp$/;

/**
 * Pids of the processes that are still working inside any of `dirs` (dead installers' work dirs):
 * a process whose command line names one of them (the `cp -Rc` of the dependency clone, `unzip`),
 * or whose current folder is inside one (`npm install` in the staged tree). A server killed with
 * SIGKILL leaves exactly these behind; removing the folder under them loses the race and leaves it
 * in place for good, so they are stopped first. Anything unreadable counts as none found.
 */
export function writersInto(dirs: string[]): number[] {
  if (dirs.length === 0) return [];
  const into = (p: string): boolean => dirs.some((d) => p === d || p.startsWith(d + path.sep));
  const found = new Set<number>();
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of ps.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && dirs.some((d) => m[2].includes(d + path.sep) || m[2].endsWith(d))) found.add(Number(m[1]));
    }
  } catch { /* no ps: nothing found */ }
  try {
    let pid = 0;
    for (const line of execFileSync('lsof', ['-nP', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0 && into(line.slice(1))) found.add(pid);
    }
  } catch { /* no lsof, or a partial listing: what was found stands */ }
  found.delete(process.pid);
  return [...found];
}

function stopWriters(dirs: string[]): void {
  for (const pid of writersInto(dirs)) {
    try { process.kill(pid, 'SIGKILL'); logger.info('Stopped a process still writing into a dead installer\'s work dir', { pid }); } catch { /* already gone */ }
  }
}

/**
 * EVERY start, before anything else: remove the leftovers of an update that was killed
 * mid-flight — work dirs whose installer process is gone (a live installer's own staging is
 * never named here, `deadInstallWorkDirs` keeps that), and marker temp files stranded beside
 * `update-state.json` whose writer process is gone. A removal that fails (a straggler still writing into the tree is the
 * case that used to wedge this forever) gets one log line of its own and is simply tried
 * again at the next start — no retry loop, no timer: every start sweeps again anyway. The
 * live `platform` folder and the current `update-state.json` can never match either pattern.
 */
export async function cleanUpdateLeftovers(dojoDir: string): Promise<{ deleted: string[]; failed: string[] }> {
  const leftovers = [...deadInstallWorkDirs(dojoDir)];
  let tmps: string[] = [];
  try { tmps = fs.readdirSync(dojoDir).filter((n) => {
      // Only a temp file whose writer is dead: the watchdog records transitions at boot and
      // must not lose its temp file between its write and its rename.
      const m = UPDATE_STATE_TMP.exec(n);
      return m !== null && !pidAlive(Number(m[1]));
    }).map((n) => path.join(dojoDir, n)); } catch { /* nothing to name */ }
  leftovers.push(...tmps);
  const names = leftovers.map((p) => path.basename(p));
  const deleted: string[] = [];
  const failed: string[] = [];
  const removeOne = (p: string): Promise<void> => new Promise((resolve, reject) => {
    // Hand `fs.rm` the callback IT reports through: its promise-less form here returns
    // `undefined` and deletes nothing while rimraf dies behind — a sweep on that would
    // log a clean-up that never happened. The callback is the contract it keeps.
    fs.rm(p, { recursive: true, force: true }, (err) => (err ? reject(err) : resolve()));
  });
  // The writers go first. A SIGKILLed server leaves its `cp` running, and removing a folder under a
  // live writer is what left it behind for good. Once they are stopped (a kill takes effect at once),
  // a removal that still finds an entry in the folder is the dying writer's last one: ask again.
  stopWriters(leftovers);
  const removeStopped = async (p: string): Promise<void> => {
    try { await removeOne(p); } catch (err) {
      if (!fs.existsSync(p)) return;
      stopWriters(leftovers);
      await removeOne(p);
      void err;
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
