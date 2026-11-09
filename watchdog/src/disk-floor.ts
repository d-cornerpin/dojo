// The watchdog's one disk floor: never below the largest threshold the platform's own
// operations refuse at (its backup guard measures the database and passes a flat gigabyte
// once the database is big; a flat floor alone could call disk healthy while backups could not run).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** SHARED CONTRACT (hand copy): the platform's backup disk multiple; bound by its self-integrity test. */
export const PLATFORM_BACKUP_FREE_DISK_MULTIPLE = 2;

export const WATCHDOG_DISK_FLOOR_BYTES = 1024 * 1024 * 1024;

const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');

export function measureDatabaseBytes(dbPath: string = DB_PATH): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const st = fs.statSync(`${dbPath}${suffix}`);
      if (st.isFile()) total += st.size;
    } catch {
      // Missing wal/shm is normal; an unreadable database lands on the flat floor, never on a floor of zero.
    }
  }
  return total;
}

export type DiskFloor = {
  bytes: number;
  binding: 'floor' | 'backup';
};

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
