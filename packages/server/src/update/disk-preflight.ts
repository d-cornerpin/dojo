// ════════════════════════════════════════════════════════════════════════════════════════
// THE UPDATE CHECKS DISK SPACE AND TELLS THE USER — owner-requested 2026-08-06, landed by
// SWEEP CORE-2 item 3 (SWEEP-F's INBOUND). His words:
//
//   *"add a disk space check to the update mechanism so we can give the user a notification
//    either before the update starts, or if it fails, when they don't have enough disk space."*
//
// ── THE GAP THIS CLOSES, MEASURED ───────────────────────────────────────────────────────
// SWEEP-A built the after-the-fact half. `db/migration-backup.ts` refuses the migration chain
// when free disk is under 2x the live database, and that refusal is MEASURED to be protective:
// with nothing applied, the watchdog's `decideAutoRollback` returns `rollback` rather than
// `escalate` (`task-RESTORE-PATH-report.md`, three recorded verdicts). RESTORE-PATH also made
// the OUTCOME loud — `config.migration_backup_last`, `GET /api/update/db-backup`, and the
// Update tab's `DataBackupNotice`.
//
// What did not exist is the check BEFORE the owner commits. `applyUpdate` measured no free
// space at all before `curl` -> `unzip` -> `cp -R` of a 100-200 MB tree, in a module whose own
// header records that these copies "have been reported to fill mac mini disks". The sequence a
// short box actually got was: download, extract, copy, swap, restart — and only then a refusal,
// at a moment when the dashboard is down and the message is a line in a log file.
//
// ── THE NEED IS DERIVED. EVERY COMPONENT, FROM A MEASUREMENT OR THE RELEASE ITSELF ──────
// The owner's requirement says "both derived, never guessed", and there are four things that
// land on this disk during an apply. Each is measured, none is a constant:
//
//   1. THE DATABASE BACKUP        `MIGRATION_BACKUP_FREE_DISK_MULTIPLE` x (db + wal + shm).
//                                 The multiple is IMPORTED from the module that enforces it,
//                                 so the pre-flight cannot promise room the chain then refuses.
//                                 The WAL and SHM are in the footprint because a busy box
//                                 carries recent writes there until the next checkpoint.
//   2. THE DOWNLOADED ZIP         the release asset's OWN `size`, from the GitHub metadata the
//                                 update check already holds. Not an estimate of it.
//   3. THE EXTRACTED TREE         `unzip` writes it beside the zip. Its size is not knowable
//                                 before extraction, so it is taken as the size of the tree
//                                 ALREADY INSTALLED on this box — a real measurement of the
//                                 same artifact one version back, which is the closest honest
//                                 number available and is stated as such rather than guessed at.
//   4. THE `cp -R` APP BACKUP     the same measured tree again: `applyUpdate` copies
//                                 `~/.dojo/platform` to `platform.backup-<version>` whole.
//
// ⚠ WHAT THIS DELIBERATELY DOES NOT DO: it does not model the pruning that happens along the
// way (`MAX_BACKUPS_TO_KEEP = 2`, the tmpdir cleanup). Those FREE space, so ignoring them makes
// the pre-flight conservative in the only direction it is allowed to err. Saying "you may be
// short" and being wrong costs the owner a look at his disk; saying "you have room" and being
// wrong costs him a half-applied update.
//
// ── AND IT MUST NOT INVENT A NO ─────────────────────────────────────────────────────────
// When the volume cannot be measured (`statfs` unavailable on the platform, an exotic mount),
// the answer is "we could not tell", and the update proceeds. That is the convention
// `db/migration-backup.ts:155` and `gateway/routes/migration.ts:147` both already keep, and it
// is the right one: a platform that cannot answer the question has not earned the right to
// block on it. The downstream refusal still stands as the real net.
// ════════════════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logger.js';
import {
  MIGRATION_BACKUP_FREE_DISK_MULTIPLE, MIGRATION_BACKUP_OVERRIDE_FILE,
  migrationBackupOverridePresent,
} from '../db/migration-backup.js';

const logger = createLogger('update-disk');

export interface UpdateDiskNeed {
  /** False only when the volume WAS measured and is short. An unmeasurable volume is `true`. */
  ok: boolean;
  /** True when free space was actually read. False means "we could not tell". */
  measured: boolean;
  /** Free bytes on the volume holding the data directory, or null when unmeasurable. */
  freeBytes: number | null;
  /** The live database footprint: main + WAL + SHM. */
  dbBytes: number;
  /** `dbBytes` x the multiple the migration chain enforces. */
  backupNeedBytes: number;
  /** The release artifact's own size, from its GitHub metadata. */
  artifactBytes: number;
  /** The installed platform tree, measured on this disk. */
  platformBytes: number;
  /** Everything that lands on the disk during one apply. */
  totalNeedBytes: number;
  /** How much more is needed. Zero when there is room, or when nothing could be measured. */
  shortfallBytes: number;
}

/** Bytes of one file, or 0 if it is not there. */
function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Bytes of a directory tree. Symlinks are not followed — the `cp -R` copies the link. */
function treeSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    if (!d) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { total += fs.statSync(p).size; } catch { /* raced with a write; skip */ }
    }
  }
  return total;
}

/**
 * A byte count a person can read.
 *
 * SCALE-AWARE on purpose: `migration-backup.ts` prints GB unconditionally, which reads as
 * "0.03 GB" on a 31 MB database — a number that tells the owner nothing about the size of his
 * problem. GB is right for the disk-sized quantities and MB for the file-sized ones, and
 * choosing per number is the difference between a sentence he can act on and one he skims.
 */
export function readableBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * Measure what one update needs against what this box has.
 *
 * Pure with respect to the world it is handed: `dbPath` and `platformDir` are parameters so a
 * constrained-volume rehearsal (and the unit suite) can point it at a body of a known size.
 */
export function measureUpdateDiskNeed(input: {
  /** The release asset's own size, in bytes, from its GitHub metadata. */
  artifactBytes: number;
  /** The live database file. Defaults to the running box's. */
  dbPath?: string;
  /** The installed platform tree. Defaults to the running box's. */
  platformDir?: string;
}): UpdateDiskNeed {
  const dbPath = input.dbPath ?? path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
  const platformDir = input.platformDir ?? path.join(os.homedir(), '.dojo', 'platform');

  const dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);
  const backupNeedBytes = dbBytes * MIGRATION_BACKUP_FREE_DISK_MULTIPLE;
  const platformBytes = treeSize(platformDir);
  const artifactBytes = Math.max(0, input.artifactBytes);
  // zip + extracted tree + `cp -R` of the current install + the database snapshot.
  const totalNeedBytes = backupNeedBytes + artifactBytes + platformBytes * 2;

  let freeBytes: number | null = null;
  try {
    const st = fs.statfsSync(path.dirname(dbPath));
    freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch (err) {
    logger.debug('Free-disk check unavailable for the update pre-flight; not blocking', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const measured = freeBytes !== null;
  const shortfallBytes = freeBytes === null ? 0 : Math.max(0, totalNeedBytes - freeBytes);
  return {
    ok: !measured || shortfallBytes === 0,
    measured, freeBytes, dbBytes, backupNeedBytes, artifactBytes, platformBytes,
    totalNeedBytes, shortfallBytes,
  };
}

/**
 * What to tell the owner, in his own language.
 *
 * Deliberately shaped like `migration-backup.ts`'s `refusalMessage`: what is wrong, what it
 * costs, and what to do — because the two messages describe the same disk and he should not
 * have to reconcile two vocabularies for one problem.
 */
export function describeUpdateDiskShortfall(need: UpdateDiskNeed): string {
  if (need.ok) return '';
  return [
    'There is not enough free disk space to install this update safely.',
    '',
    `The update needs about ${readableBytes(need.totalNeedBytes)} free while it works: `
    + `${readableBytes(need.artifactBytes)} to download, ${readableBytes(need.platformBytes * 2)} to unpack it and keep `
    + `a copy of the version you have now, and ${readableBytes(need.backupNeedBytes)} to back up your data `
    + `(your database is ${readableBytes(need.dbBytes)}). This disk has ${readableBytes(need.freeBytes ?? 0)} free — `
    + `about ${readableBytes(need.shortfallBytes)} short.`,
    '',
    'Nothing has been downloaded and nothing has changed. Free up some space and check for '
    + 'updates again, and Dojo will carry on from here.',
  ].join('\n');
}

/**
 * The pre-flight's verdict on whether this update may proceed.
 *
 * Returns the refusal text, or `null` to proceed. The override is the SAME one the migration
 * chain honours — one permission, not two — and it is PEEKED at rather than consumed: the
 * one-shot file exists for the chain that runs after the restart, and a pre-flight that ate it
 * would wave the download through and then have the chain refuse anyway.
 */
export function updateDiskRefusal(
  need: UpdateDiskNeed, opts?: { dataDir?: string },
): string | null {
  if (need.ok) return null;
  const dataDir = opts?.dataDir ?? path.join(os.homedir(), '.dojo', 'data');
  if (migrationBackupOverridePresent(dataDir)) {
    logger.warn(
      'Starting an update with too little free disk because an override is set. '
      + 'If this goes wrong, the data may not be recoverable.',
      { freeBytes: need.freeBytes, neededBytes: need.totalNeedBytes, shortfallBytes: need.shortfallBytes },
    );
    return null;
  }
  return [
    describeUpdateDiskShortfall(need),
    '',
    'If you accept that you may not be able to go back, run this once and try again:',
    `  touch ${path.join(dataDir, MIGRATION_BACKUP_OVERRIDE_FILE)}`,
  ].join('\n');
}

/**
 * Did this failure happen because the disk filled up?
 *
 * The update shells out to `curl`, `unzip`, `cp` and `rsync`, so the evidence arrives in three
 * different shapes: an `ENOSPC` code from Node's own fs calls, the POSIX sentence those tools
 * print, and `unzip`'s own wording. All three are the same fact, and the owner is entitled to
 * be told the fact rather than the shape.
 *
 * The negative control is the point of the narrowness: a 404 from GitHub must NOT be
 * relabelled a disk problem, because sending someone to clear space over a network error is a
 * worse failure than the generic message it replaced.
 */
export function isOutOfSpaceError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOSPC') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /no space left on device|ENOSPC|disk full|write error \(disk full/i.test(msg);
}

/** What the owner is told when an update dies mid-flight because the disk filled. */
export function outOfSpaceFailureMessage(detail: string): string {
  return (
    'The update ran out of disk space part-way through and stopped. '
    + 'Free up space on this Mac and run the update again — Dojo keeps a copy of the version '
    + 'you were on and will not start a new version it could not finish installing. '
    + `(Technical detail: ${detail})`
  );
}
