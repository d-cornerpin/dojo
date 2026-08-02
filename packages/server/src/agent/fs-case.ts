// ════════════════════════════════════════════════════════════════════════════
// FILESYSTEM CASE SENSITIVITY — a leaf with ZERO platform imports (PHASE-5 T2).
//
// This was born inside `agent/path-guards.ts` (PHASE-0 T10) and moved here for
// one structural reason: T2's merged deny list (`agent/brokers/deny.ts`) needs
// the fold, and `path-guards.ts` needs the deny list — importing both ways would
// close exactly the kind of cycle this phase is deleting. `path-guards.ts`
// re-exports every name below, so no existing consumer moved.
//
// The fold is driven by a BOOT PROBE, never by `process.platform`: the question
// is what the filesystem does, and a Linux box (or a case-sensitive APFS volume)
// must NOT fold, or every legitimately capitalised path becomes a false block.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('fs-case');

/** The three `node:fs` calls the probe needs. Injected so the boot caller owns
 *  the fs import (this module stays effect-free) and so the unit test can drive
 *  BOTH outcomes without a real case-insensitive volume to test on. */
export interface ProbeFs {
  writeFileSync(file: string, data: string): void;
  existsSync(file: string): boolean;
  unlinkSync(file: string): void;
}

// null = not yet probed. The getter treats that as "fold" (see below).
let fsCaseInsensitive: boolean | null = null;

/**
 * Probe whether `dir` lives on a case-insensitive filesystem: write `…-A.tmp`,
 * ask whether `…-a.tmp` exists, clean up. The pid is in the name so two
 * processes probing the same directory cannot answer each other's question.
 *
 * Returns false when the probe cannot run at all (unwritable dir) — a failed
 * probe is not evidence of case-insensitivity, and the caller keeps whatever
 * the flag already held.
 */
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
    // On a case-insensitive volume `upper` and `lower` are the same inode, so
    // one unlink clears both names.
    try { fsImpl.unlinkSync(upper); } catch { /* nothing to clean up */ }
  }
}

/** Record the probe's answer. Called once at boot; called by tests to cover
 *  both filesystems. */
export function setFsCaseInsensitive(value: boolean): void {
  fsCaseInsensitive = value;
}

/**
 * Does this box fold case in path names?
 *
 * Before the boot probe has run this answers TRUE — fail closed. Folding when
 * we should not costs an over-block on a file literally named `Secrets.yaml`;
 * not folding when we should costs every sensitive-path guard at once. Boot
 * replaces the guess with a measurement within milliseconds of start-up.
 */
export function isFsCaseInsensitive(): boolean {
  return fsCaseInsensitive ?? true;
}

/** Lower-case a path (or a command line containing one) when — and only when —
 *  the filesystem itself ignores case. Identity on a case-sensitive box. */
export function foldPath(value: string): string {
  return isFsCaseInsensitive() ? value.toLowerCase() : value;
}
