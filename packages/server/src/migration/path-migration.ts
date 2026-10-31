// ════════════════════════════════════════
// Path Migration — update home directory references after import
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const logger = createLogger('path-migration');

/**
 * Replace `oldHome` with `newHome` in `text`, but only where `oldHome` is a whole
 * path prefix: the next character must not continue a folder name (letter, digit,
 * `.`, `_`, `-`). So `<oldHome>/x` and a bare `<oldHome>` are swapped while a longer
 * folder name that merely starts with the old home is left alone. `oldHome` is matched literally and `newHome`
 * is inserted literally (a `$` in it is never read as a pattern).
 */
export function swapHome(text: string, oldHome: string, newHome: string): string {
  if (!oldHome) return text;
  const escaped = oldHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9._-])`, 'g'), () => newHome);
}

export function migratePaths(rawOldHome: string, rawNewHome: string, dojoDir: string): void {
  if (rawOldHome === rawNewHome) {
    logger.info('Same home directory, no path migration needed');
    return;
  }
  if (typeof rawOldHome !== 'string' || rawOldHome.trim() === '') {
    logger.warn('Backup has no old home folder, skipping path migration');
    return;
  }
  const oldHome = rawOldHome.replace(/\/+$/, '');
  const newHome = rawNewHome.replace(/\/+$/, '');
  if (oldHome === '') {
    logger.warn('Backup has no old home folder, skipping path migration');
    return;
  }
  if (oldHome === newHome) {
    logger.info('Same home directory, no path migration needed');
    return;
  }

  logger.info('Migrating paths', { oldHome, newHome });

  // 1. Update paths in the SQLite database
  migrateDatabase(oldHome, newHome, dojoDir);

  // 2. Update paths in secrets.yaml
  migrateTextFile(path.join(dojoDir, 'secrets.yaml'), oldHome, newHome);

  // 3. Update paths in config files
  const configDir = path.join(dojoDir, 'config');
  if (fs.existsSync(configDir)) {
    migrateDirectory(configDir, oldHome, newHome);
  }

  // 4. Update paths in technique TECHNIQUE.md files
  const techniquesDir = path.join(dojoDir, 'techniques');
  if (fs.existsSync(techniquesDir)) {
    migrateDirectory(techniquesDir, oldHome, newHome);
  }

  // 5. Update paths in the Cloudflare tunnel config (~/.cloudflared). config.yml
  //    references the credentials file by absolute path under the old home
  //    (e.g. credentials-file: /Users/<old>/.cloudflared/<uuid>.json); without
  //    this the named tunnel can't find its key on the new machine. The
  //    credentials .json itself holds only base64 secrets (no home paths), so
  //    migrateTextFile leaves it untouched.
  const cloudflaredDir = path.join(newHome, '.cloudflared');
  if (fs.existsSync(cloudflaredDir)) {
    migrateDirectory(cloudflaredDir, oldHome, newHome);
  }

  logger.info('Path migration complete');
}

function migrateDatabase(oldHome: string, newHome: string, dojoDir: string): void {
  const dbPath = path.join(dojoDir, 'data', 'dojo.db');
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  try {
    // Technique directory paths
    try {
      const techniques = db.prepare("SELECT id, directory_path FROM techniques WHERE directory_path LIKE ?").all(`${oldHome}%`) as Array<{ id: string; directory_path: string }>;
      const updateTech = db.prepare('UPDATE techniques SET directory_path = ? WHERE id = ?');
      for (const t of techniques) {
        updateTech.run(swapHome(t.directory_path, oldHome, newHome), t.id);
      }
      if (techniques.length > 0) {
        logger.info('Updated technique paths', { count: techniques.length });
      }
    } catch { /* table may not exist */ }

    // Platform config paths
    try {
      const configs = db.prepare("SELECT key, value FROM config WHERE value LIKE ?").all(`%${oldHome}%`) as Array<{ key: string; value: string }>;
      const updateConfig = db.prepare('UPDATE config SET value = ? WHERE key = ?');
      for (const c of configs) {
        updateConfig.run(swapHome(c.value, oldHome, newHome), c.key);
      }
      if (configs.length > 0) {
        logger.info('Updated config paths', { count: configs.length });
      }
    } catch { /* table may not exist */ }

    // Agent system_prompt_path and any config JSON that might contain paths
    try {
      const agents = db.prepare("SELECT id, system_prompt_path, config FROM agents WHERE system_prompt_path LIKE ? OR config LIKE ?").all(`${oldHome}%`, `%${oldHome}%`) as Array<{ id: string; system_prompt_path: string | null; config: string | null }>;
      const updateAgent = db.prepare('UPDATE agents SET system_prompt_path = ?, config = ? WHERE id = ?');
      for (const a of agents) {
        const newPromptPath = a.system_prompt_path ? swapHome(a.system_prompt_path, oldHome, newHome) : null;
        const newConfig = a.config ? swapHome(a.config, oldHome, newHome) : null;
        updateAgent.run(newPromptPath, newConfig, a.id);
      }
      if (agents.length > 0) {
        logger.info('Updated agent paths', { count: agents.length });
      }
    } catch { /* table may not exist */ }

    // Upload file paths in messages (attachments JSON)
    //
    // PHASE-1 T4 (2026-07-27): this is the ONE write against `messages` that does NOT go
    // through memory/message-store.ts, and the exemption is deliberate — it is named in
    // OFFLINE_DB_TOOLS in memory/__tests__/single-writer-conformance.test.ts, with a test
    // that only lets a file sit there if it really does open its own connection.
    //
    // The reason: this function rewrites $HOME references inside a database file taken
    // from ANOTHER MACHINE, and it opens that file itself (`new Database(dbPath)` above,
    // closed in the finally). The writer module writes through the app singleton. Routing
    // this through it would open a SECOND connection to a database the import path is
    // about to move, and would silently target the wrong file the day `dojoDir` is ever
    // passed anything other than the live one — a correctness risk taken to satisfy a rule
    // about the RUNNING platform's store, which this is not.
    try {
      const msgs = db.prepare("SELECT id, attachments FROM messages WHERE attachments LIKE ?").all(`%${oldHome}%`) as Array<{ id: string; attachments: string }>;
      const updateMsg = db.prepare('UPDATE messages SET attachments = ? WHERE id = ?');
      for (const m of msgs) {
        updateMsg.run(swapHome(m.attachments, oldHome, newHome), m.id);
      }
      if (msgs.length > 0) {
        logger.info('Updated message attachment paths', { count: msgs.length });
      }
    } catch { /* table may not exist */ }

  } finally {
    db.close();
  }
}

function migrateTextFile(filePath: string, oldHome: string, newHome: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(oldHome)) {
    const updated = swapHome(content, oldHome, newHome);
    if (updated !== content) fs.writeFileSync(filePath, updated);
    logger.info('Updated paths in file', { file: path.basename(filePath) });
  }
}

function migrateDirectory(dirPath: string, oldHome: string, newHome: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      migrateDirectory(fullPath, oldHome, newHome);
    } else {
      // Only process text-like files
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.txt', '.yaml', '.yml', '.json', '.toml', '.sh'].includes(ext)) {
        migrateTextFile(fullPath, oldHome, newHome);
      }
    }
  }
}
