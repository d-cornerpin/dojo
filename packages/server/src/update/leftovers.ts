import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { deadInstallWorkDirs, pidAlive, INSTALL_CEILING_MS } from './install-tree.js';

const logger = createLogger('update-leftovers');

/** Temp files the marker writer leaves when killed between its temp write and rename (`update-state.ts`). */
const UPDATE_STATE_TMP = /^update-state\.json\.(\d+)\.(?:.+\.)?tmp$/;

/** Older than one whole install attempt (the dir name ends in its start time in ms). */
const pastOneAttempt = (dir: string, now: number): boolean =>
  !(now - Number(path.basename(dir).split('-').pop()) < INSTALL_CEILING_MS);

/** Every start: remove what a killed update left behind; a failed removal is retried at the next start. */
export async function cleanUpdateLeftovers(dojoDir: string, now = Date.now()): Promise<{ deleted: string[]; failed: string[] }> {
  let tmps: string[] = [];
  try {
    tmps = fs.readdirSync(dojoDir).filter((n) => { const m = UPDATE_STATE_TMP.exec(n); return m !== null && !pidAlive(Number(m[1])); })
      .map((n) => path.join(dojoDir, n));
  } catch { /* nothing to name */ }
  const leftovers = [...deadInstallWorkDirs(dojoDir).filter((d) => pastOneAttempt(d, now)), ...tmps];
  const results = await Promise.allSettled(leftovers.map((p) => fs.promises.rm(p, { recursive: true, force: true })));
  const deleted: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    const name = path.basename(leftovers[i]);
    if (r.status === 'fulfilled') { deleted.push(name); return; }
    failed.push(name);
    logger.warn('Update leftover could not be removed; it will be tried again at the next start', { item: name, error: String(r.reason) });
  });
  if (deleted.length > 0) logger.info('Removed leftovers of an interrupted update', { deleted });
  return { deleted, failed };
}
