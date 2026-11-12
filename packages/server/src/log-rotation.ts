// Live `dojo.log` plus exactly one backup `dojo.log.1`; past 10 MB the live file becomes the backup.
// logger.ts throttles checks per process, so concurrent processes sharing a log dir must not
// destroy the backup: guard 1 deletes it only if this logger wrote it (empty, or starts with
// OUR_LINE_PREFIX); guard 2 refuses the whole rotation (rename clobbers too) if it is under 60 s old.

import fs from 'node:fs';

const MAX_LOG_SIZE = 10 * 1024 * 1024;

// First bytes of every line this logger writes (createLogger builds `timestamp` first).
const OUR_LINE_PREFIX = '{"timestamp":"';

// Not above the 60 s check throttle in logger.ts: one process never rotates twice inside it.
const MIN_BACKUP_AGE_MS = 60_000;

export type RotationOutcome =
  | 'no-log-file'
  | 'under-threshold'
  | 'rotated'
  | 'refused-foreign-backup'
  | 'refused-young-backup';

function isOurLogFile(p: string): boolean {
  let fd: number | null = null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) return false;
    if (st.size === 0) return true;
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(512, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8').startsWith(OUR_LINE_PREFIX);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

// One rotation attempt with both guards; logger.ts's rotateIfNeeded() is the production caller.
export function rotateLogFile(logFile: string, now: number = Date.now()): RotationOutcome {
  let size: number;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return 'no-log-file';
  }
  if (size <= MAX_LOG_SIZE) return 'under-threshold';

  const backup = logFile + '.1';
  let backupStat: fs.Stats | null = null;
  try {
    backupStat = fs.lstatSync(backup);
  } catch {
    backupStat = null;
  }

  if (backupStat !== null) {
    if (!isOurLogFile(backup)) {
      process.stderr.write(
        `Log rotation refused: ${backup} is not a file this logger wrote; leaving it alone.\n`,
      );
      return 'refused-foreign-backup';
    }
    if (now - backupStat.mtimeMs < MIN_BACKUP_AGE_MS) {
      process.stderr.write(
        `Log rotation refused: ${backup} was written ${Math.round((now - backupStat.mtimeMs) / 1000)}s ago; ` +
          'another process rotated just now and this would destroy it.\n',
      );
      return 'refused-young-backup';
    }
    fs.unlinkSync(backup);
  }

  fs.renameSync(logFile, backup);
  return 'rotated';
}

