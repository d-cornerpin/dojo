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
