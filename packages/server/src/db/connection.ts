import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { homeDir } from '../home.js';
import { guardReadOnly } from './read-only-door.js';

const logger = createLogger('db');
const DB_DIR = path.join(homeDir(), '.dojo', 'data');
const DB_PATH = path.join(DB_DIR, 'dojo.db');

let db: Database.Database | null = null;
let readOnlyDb: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    logger.info('Created data directory', { path: DB_DIR });
  }

  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Connection-wide settings, set here because this is the only place the platform opens its database.
  // Asserted by readback in db/__tests__/connection-pragmas.test.ts: SQLite accepts a bad value silently.
  // Negative cache_size is KiB, not pages: 32 MB keeps the working set through one large scan.
  db.pragma('cache_size = -32000');
  // Read pages through mmap instead of one read() syscall per page (256 MB window).
  db.pragma('mmap_size = 268435456');
  // Sorts, GROUP BY spills and temp b-trees stay in RAM instead of a scratch file.
  db.pragma('temp_store = MEMORY');
  // Planner statistics for every table, sampled at most 400 rows per index so it stays quick on any history.
  try {
    db.pragma('analysis_limit = 400');
    db.pragma('optimize = 0x10002');
  } catch (err) {
    logger.warn('Planner statistics could not be refreshed at open', { error: err instanceof Error ? err.message : String(err) });
  }

  const fkStatus = db.pragma('foreign_keys', { simple: true });
  if (fkStatus !== 1) {
    logger.warn('Foreign keys not enabled, forcing ON', { status: fkStatus });
    db.exec('PRAGMA foreign_keys = ON');
  }

  logger.info('Database connection established', { path: DB_PATH });

  return db;
}

/** The connection every dojo_inspect view reads through. `readonly` makes SQLite refuse a write,
 *  the door refuses anything but a read, and WAL lets it read beside the writer. */
export function getReadOnlyDb(): Database.Database {
  if (readOnlyDb) return readOnlyDb;
  getDb(); // the file and its WAL exist before a readonly open
  readOnlyDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  readOnlyDb.pragma('query_only = 1');
  readOnlyDb.pragma('busy_timeout = 2000');
  return guardReadOnly(readOnlyDb); // only a read gets through: read-only-door.ts
}

export function closeDb(): void {
  readOnlyDb?.close();
  readOnlyDb = null;
  if (db) {
    try { db.pragma('optimize'); } catch { /* a close never fails on statistics */ }
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

export function getDbPath(): string {
  return DB_PATH;
}
