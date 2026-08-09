// ════════════════════════════════════════
// The watchdog's disk floor — ONE question, ONE answer.
// SWEEP CORE-2 item 6, rider (iii).
//
// ── THE TWO ANSWERS THAT DID NOT KNOW ABOUT EACH OTHER ──
// Two thresholds in this tree answered "is there enough disk?":
//
//   the watchdog   a FLAT 1 GB — text the owner, checked every 120 s.
//   the platform   MIGRATION_BACKUP_FREE_DISK_MULTIPLE x (db + wal + shm) —
//                  refuse the pre-migration backup (db/migration-backup.ts) and,
//                  since CORE-2 item 3, refuse the whole update before the first
//                  byte is downloaded (update/disk-preflight.ts).
//
// THE ORDERING BETWEEN THEM WAS ACCIDENTAL, AND IT INVERTS. On the 198 MB body
// REVERT-REHEARSE measured, the platform's threshold is 0.58 GB, so the watchdog
// happens to speak first and everything looks fine. At a 600 MB database it is
// 1.2 GB — ABOVE the flat gigabyte — and the box silently loses the ability to
// back itself up before a migration while the watchdog is still reporting disk as
// healthy. The owner would learn about it from a refused update, which is the
// warning arriving after the thing it was supposed to warn about.
//
// ── ORDERED, NOT COLLAPSED ──
// They are not merged, because they answer genuinely different questions: the
// watchdog asks "is this box in trouble" continuously and with no operation in
// hand; the platform asks "can THIS operation complete" at the moment somebody
// commits to it. What is added is the ORDERING, as a law:
//
//     the watchdog's floor is never below the largest threshold the platform's
//     own operations will refuse at.
//
// ── THE MULTIPLE IS HAND-COPIED, AND SOMETHING BINDS IT ──
// `check-watchdog-contract.mjs` RULE 3 forbids this package importing the
// platform (the whole reason the watchdog can run when the platform will not
// boot). That gate's COPIES list cannot take a third file — it requires every
// listed copy to declare every governed member — so the binding for THIS number
// lives in `packages/server/src/update/__tests__/watchdog-self-integrity.test.ts`,
// which reads both files and fails if they disagree, and which runs inside the
// never-skippable `unit-suite` release gate. Named here so the copy is not
// resting on a comment.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** SHARED CONTRACT with `MIGRATION_BACKUP_FREE_DISK_MULTIPLE` in
 *  packages/server/src/db/migration-backup.ts. Bound by the suite named above. */
export const PLATFORM_BACKUP_FREE_DISK_MULTIPLE = 2;

/** The flat minimum, carried verbatim from the alarm this replaces: below a
 *  gigabyte a Mac is in trouble whatever the database weighs. */
export const WATCHDOG_DISK_FLOOR_BYTES = 1024 * 1024 * 1024;

const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');

/** Bytes of the platform database as it sits on disk, WAL and SHM included —
 *  the same three files the platform's own backup arithmetic measures. Returns 0
 *  when nothing can be read, which lands on the flat floor rather than on zero. */
export function measureDatabaseBytes(dbPath: string = DB_PATH): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = fs.statSync(`${dbPath}${suffix}`);
      if (st.isFile()) total += st.size;
    } catch {
      // A missing wal/shm is normal; a missing database means we fall back.
    }
  }
  return total;
}

export type DiskFloor = {
  bytes: number;
  /** Which answer bound — so the owner can be told WHY the number is the number. */
  binding: 'floor' | 'backup';
};

/**
 * The floor this box must stay above: the LARGER of the flat minimum and what a
 * pre-migration backup of this database would need.
 *
 * An unmeasurable or nonsensical database size falls back to the flat minimum.
 * That direction is deliberate: the alternative — deriving a floor of zero from a
 * database we could not read — would turn a failed measurement into silence,
 * which is the failure mode this whole item is about.
 */
export function diskFloorBytes(databaseBytes: number = measureDatabaseBytes()): DiskFloor {
  const db = typeof databaseBytes === 'number' && Number.isFinite(databaseBytes) && databaseBytes > 0
    ? databaseBytes
    : 0;
  const backupNeed = db * PLATFORM_BACKUP_FREE_DISK_MULTIPLE;
  return backupNeed > WATCHDOG_DISK_FLOOR_BYTES
    ? { bytes: backupNeed, binding: 'backup' }
    : { bytes: WATCHDOG_DISK_FLOOR_BYTES, binding: 'floor' };
}

const GB = 1024 * 1024 * 1024;
export const toGb = (bytes: number): number => bytes / GB;
