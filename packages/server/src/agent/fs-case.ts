// A zero-platform-import leaf; path-guards.ts re-exports these names so the deny list can use
// the fold without closing a cycle. A BOOT PROBE decides it, never `process.platform`.

import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('fs-case');

export interface ProbeFs {
  writeFileSync(file: string, data: string): void;
  existsSync(file: string): boolean;
  unlinkSync(file: string): void;
}

// null = not yet probed: the getter fails closed, since not folding loses every guard at once.
let fsCaseInsensitive: boolean | null = null;

/** Write `A.tmp`, ask for `a.tmp`, clean up; the pid keeps two probes apart. false = case-sensitive,
 *  or the probe could not run (a failed probe is no evidence of case-insensitivity). */
export function probeFsCaseInsensitive(dir: string, fsImpl: ProbeFs): boolean {
  const upper = path.join(dir, `dojo-fscase-${process.pid}-A.tmp`);
  const lower = path.join(dir, `dojo-fscase-${process.pid}-a.tmp`);
  try {
    fsImpl.writeFileSync(upper, 'fs case probe');
    return fsImpl.existsSync(lower);
  } catch (err) {
    logger.warn('Filesystem case probe failed; keeping the current fold setting', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    // Both names are one inode on a case-insensitive volume, so one unlink clears both.
    try { fsImpl.unlinkSync(upper); } catch { /* nothing to clean up */ }
  }
}

export function setFsCaseInsensitive(value: boolean): void {
  fsCaseInsensitive = value;
}

export function isFsCaseInsensitive(): boolean {
  return fsCaseInsensitive ?? true;
}

export function foldPath(value: string): string {
  return isFsCaseInsensitive() ? value.toLowerCase() : value;
}
