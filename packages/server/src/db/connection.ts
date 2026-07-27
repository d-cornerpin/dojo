import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';

const logger = createLogger('db');
const DB_DIR = path.join(os.homedir(), '.dojo', 'data');
const DB_PATH = path.join(DB_DIR, 'dojo.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    logger.info('Created data directory', { path: DB_DIR });
  }

  db = new Database(DB_PATH);

  // Enable WAL mode and foreign keys
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // PHASE-0 T12c: the settings every statement in the platform inherits, set
  // here because this is the only place the platform opens its own database.
  // Behaviour-neutral by construction — none of the three changes a result,
  // only where the bytes come from. Asserted by readback in
  // db/__tests__/connection-pragmas.test.ts, because SQLite accepts an
  // unusable value in silence.
  //
  // Negative cache_size is KiB, not pages: 32 MB, roughly twice the whole
  // database today, so the working set is not evicted by one large scan.
  db.pragma('cache_size = -32000');
  // Read pages straight out of the OS page cache instead of a read() syscall
  // per page; 256 MB is well clear of the current file with room to grow.
  db.pragma('mmap_size = 268435456');
  // Sorts, GROUP BY spills and temp b-trees stay in RAM instead of writing a
  // scratch file next to the database.
  db.pragma('temp_store = MEMORY');

  // Verify foreign keys are actually enabled
  const fkStatus = db.pragma('foreign_keys', { simple: true });
  if (fkStatus !== 1) {
    logger.warn('Foreign keys not enabled, forcing ON', { status: fkStatus });
    db.exec('PRAGMA foreign_keys = ON');
  }

  logger.info('Database connection established', { path: DB_PATH });

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

export function getDbPath(): string {
  return DB_PATH;
}
