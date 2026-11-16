import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { swapHome } from './path-migration.js';

const logger = createLogger('path-migration');

// Columns that hold one path (rewritten only when the old home starts it) and columns of text that may
// name paths anywhere. `messages.attachments` is the one write to `messages` outside message-store: this
// is a database file from another Mac that the rewrite opens itself, before the app uses it.
const PATH_COLUMNS = [
  ['techniques', 'directory_path'], ['agents', 'system_prompt_path'], ['shared_files', 'file_path'],
  ['generation_jobs', 'asset_path'], ['video_jobs', 'asset_path'], ['turn_artifacts', 'path'],
  ['dojo_reports', 'bundle_path'], ['dojo_reports', 'export_path'],
] as const;
const TEXT_COLUMNS = [
  ['config', 'value'], ['agents', 'config'], ['agents', 'permissions'], ['messages', 'attachments'], ['turn_artifacts', 'payload_json'],
] as const;

export function migrateDatabase(oldHome: string, newHome: string, dojoDir: string): void {
  const dbPath = path.join(dojoDir, 'data', 'dojo.db');
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // ONE transaction for every rewrite: a failure partway (a full disk, a locked file) rolls
  // the whole lot back and throws out of migratePaths, so the import fails and puts the
  // previous data back. Only a table or column that does not exist (an older database) is
  // skipped; any other error is real and must not be swallowed.
  const has = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
  const rewrite = (table: string, col: string, pattern: string): void => {
    if (!has(table, col)) return;
    const rows = db.prepare(`SELECT rowid AS id, ${col} AS v FROM ${table} WHERE ${col} LIKE ?`).all(pattern) as Array<{ id: number; v: string }>;
    const update = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    for (const r of rows) update.run(swapHome(r.v, oldHome, newHome), r.id);
    if (rows.length > 0) logger.info('Updated paths', { table, col, count: rows.length });
  };
  try {
    db.transaction(() => {
      for (const [table, col] of PATH_COLUMNS) rewrite(table, col, `${oldHome}%`);
      for (const [table, col] of TEXT_COLUMNS) rewrite(table, col, `%${oldHome}%`);
    })();
  } finally {
    db.close();
  }
}
