// ════════════════════════════════════════
// LOG ROTATION — THE KEEP POLICY, WRITTEN DOWN
//
// Two files, never three: the live `dojo.log`, and exactly ONE backup,
// `dojo.log.1`. When the live file passes 10 MB it BECOMES the backup and the
// previous backup is deleted. Nothing is archived, nothing is compressed, and
// there is no `.2`. That is the whole policy — it was never stated in this file
// before, which is part of how the incident below went unnoticed.
//
// Rotation is CHECKED at most once every 60 s by `logger.ts`, whose
// `lastRotateCheck` is module-level — so the throttle is PER PROCESS. One server: one throttle. Thirty
// concurrent test workers: thirty throttles, all firing at once.
//
// ── THE INCIDENT THESE GUARDS ANSWER (2026-09-16) ──
// The test suite resolved the developer's real home (no DOJO_HOME existed yet)
// and poured ~123,000 migration lines into the real `~/.dojo/logs/dojo.log` in
// seconds. Each worker crossed 10 MB on its own throttle and rotated, so the ONE
// backup was unlinked and rewritten repeatedly inside a 7-second window: the
// surviving `dojo.log.1` was 11.7 MB holding SEVEN SECONDS of test spam, and the
// real server's entire log history — the only durable record of what it had
// done — was gone.
//
// ── GUARD 1: OWNERSHIP. Never unlink a file this logger did not write. ──
// The backup is deleted only if it carries this logger's own byte signature: a
// regular file (not a symlink, not a directory) that is either empty or begins
// with `{"timestamp":"`, which is what `JSON.stringify` of a LogEntry always
// emits first. Anything else at that path belongs to someone else and is left
// exactly where it is. No sidecar marker file, because the log directory's
// contents are themselves a user-visible surface.
//
// ── GUARD 2: AGE. A backup younger than the throttle was not made by a
//    legitimate previous rotation of ours. ──
// A single server process cannot rotate twice inside 60 s: logger.ts's throttle
// spaces its checks at least that far apart, and a freshly rotated live file is
// zero bytes. So a backup younger than 60 s means SOMEONE ELSE rotated moments
// ago — the storm shape — and this rotation is refused rather than allowed to
// overwrite it. Self-healing: 60 s later the backup is old enough and rotation
// resumes.
//
// Refusal skips the whole rotation, not just the unlink, because `rename` would
// clobber the backup just as thoroughly as `unlink` does.
//
// ── PRODUCTION BEHAVIOUR IS UNCHANGED ──
// On its own files, a real server's rotation is byte-identical to the code this
// replaced: its backup always carries the signature (guard 1 passes) and is
// always at least one throttle interval old (guard 2 passes), so it unlinks and
// renames exactly as before. The guards only fire on shapes production cannot
// produce. Asserted both ways in `__tests__/log-rotation-owns-what-it-deletes.test.ts`.
// ════════════════════════════════════════

import fs from 'node:fs';

/** The live file's ceiling. Past this, it becomes the backup. */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/** The first bytes of every line this logger writes. `JSON.stringify` of a LogEntry
 *  emits `timestamp` first because the object literal in `createLogger` does. */
const OUR_LINE_PREFIX = '{"timestamp":"';

/** Backups younger than this were not produced by a previous rotation of ours. */
const MIN_BACKUP_AGE_MS = 60_000;

export type RotationOutcome =
  | 'no-log-file'
  | 'under-threshold'
  | 'rotated'
  | 'refused-foreign-backup'
  | 'refused-young-backup';

/** Does this path carry this logger's own signature? Guard 1. */
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

/**
 * One rotation attempt, with both guards. Exported so the guards can be driven
 * directly; the production caller is `rotateIfNeeded()` below and passes nothing
 * but the live log path.
 */
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

