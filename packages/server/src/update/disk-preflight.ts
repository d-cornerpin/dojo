// Before an update downloads anything, this measures what it will put on the disk and refuses with a
// plain-language message when the volume is short. Every component of the need is measured:
// the database backup (`MIGRATION_BACKUP_FREE_DISK_MULTIPLE` x db+wal+shm, imported so this cannot
// promise room the migration chain then refuses), the zip (its published size), and the extracted
// tree plus the staged dependency copy (each the size of the installed tree, since the extracted size
// is unknowable beforehand and not every volume can clone). Pruning of old backups and the work dir
// is not modelled: it frees space, so ignoring it errs the safe way. A volume that cannot be measured
// answers "could not tell" and the update proceeds (as `db/migration-backup.ts` and
// `gateway/routes/migration.ts` do); the migration chain's own refusal remains the net.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import {
  MIGRATION_BACKUP_FREE_DISK_MULTIPLE, MIGRATION_BACKUP_OVERRIDE_FILE,
  migrationBackupOverridePresent,
} from '../db/migration-backup.js';
import { homeDir } from '../home.js';
import { childFailureEvidence } from './child-failure.js';

const logger = createLogger('update-disk');

export interface UpdateDiskNeed {
  /** False only when the volume WAS measured and is short. An unmeasurable volume is `true`. */
  ok: boolean;
  /** True when free space was actually read. False means "we could not tell". */
  measured: boolean;
  freeBytes: number | null;
  dbBytes: number;
  backupNeedBytes: number;
  artifactBytes: number;
  platformBytes: number;
  totalNeedBytes: number;
  shortfallBytes: number;
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Bytes of a directory tree. Symlinks are not followed (the `cp -R` copies the link). */
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

/** GB for disk-sized numbers, MB for file-sized ones, so a 31 MB database never reads as "0.03 GB". */
export function readableBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** Measure what one update needs against this box; the paths are parameters so tests can use known sizes. */
export function measureUpdateDiskNeed(input: {
  artifactBytes: number;
  dbPath?: string;
  platformDir?: string;
}): UpdateDiskNeed {
  const dbPath = input.dbPath ?? path.join(homeDir(), '.dojo', 'data', 'dojo.db');
  const platformDir = input.platformDir ?? path.join(homeDir(), '.dojo', 'platform');

  const dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`);
  const backupNeedBytes = dbBytes * MIGRATION_BACKUP_FREE_DISK_MULTIPLE;
  const platformBytes = treeSize(platformDir);
  const artifactBytes = Math.max(0, input.artifactBytes);
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

/** The owner's message; same words and shape as migration-backup.ts `refusalMessage` (same disk). */
export function describeUpdateDiskShortfall(need: UpdateDiskNeed): string {
  if (need.ok) return '';
  return [
    'There is not enough free disk space to install this update safely.',
    '',
    `The update needs about ${readableBytes(need.totalNeedBytes)} free while it works: `
    + `${readableBytes(need.artifactBytes)} to download, ${readableBytes(need.platformBytes * 2)} to unpack it and `
    + `prepare it beside the version you have now, and ${readableBytes(need.backupNeedBytes)} to back up your data `
    + `(your database is ${readableBytes(need.dbBytes)}). This disk has ${readableBytes(need.freeBytes ?? 0)} free — `
    + `about ${readableBytes(need.shortfallBytes)} short.`,
    '',
    'Nothing has been downloaded and nothing has changed. Free up some space and check for '
    + 'updates again, and Dojo will carry on from here.',
  ].join('\n');
}

/**
 * The refusal text, or `null` to proceed. The migration chain's override is honoured and only peeked
 * at, never consumed: the chain that runs after the restart still needs it.
 */
export function updateDiskRefusal(
  need: UpdateDiskNeed, opts?: { dataDir?: string },
): string | null {
  if (need.ok) return null;
  const dataDir = opts?.dataDir ?? path.join(homeDir(), '.dojo', 'data');
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

/** Did the disk fill up? ENOSPC, the POSIX message or unzip's wording; never a plain network error. */
export function isOutOfSpaceError(err: unknown): boolean {
  if ((err as { code?: string } | null)?.code === 'ENOSPC') return true;
  // A child's failure is a plain object (stdout, stderr, exit code), not an Error.
  return /no space left on device|ENOSPC|disk full|write error \(disk full/i.test(childFailureEvidence(err));
}

/** What the owner is told when an update dies mid-flight because the disk filled. */
export function outOfSpaceFailureMessage(detail: string): string {
  return (
    'The update ran out of disk space part-way through and stopped before switching anything. '
    + 'Free up space on this Mac and run the update again — the new version is prepared beside '
    + 'the one you have, and Dojo never switches to a version it could not finish preparing. '
    + `(Technical detail: ${detail})`
  );
}
