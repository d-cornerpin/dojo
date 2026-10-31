import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { deadInstallWorkDirs, pidAlive } from './install-tree.js';

const logger = createLogger('update-leftovers');

/** Temp files the marker writer leaves when a kill lands between its temp write and its
 *  rename (`update-state.ts`'s `tempPath`). The record itself and its `.lock` cannot match. */
const UPDATE_STATE_TMP = /^update-state\.json\.(\d+)\.(?:.+\.)?tmp$/;

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
  const results = await Promise.allSettled(leftovers.map((p) => removeOne(p)));
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
