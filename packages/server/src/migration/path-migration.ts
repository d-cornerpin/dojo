// ════════════════════════════════════════
// Path Migration — update home directory references after import
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const logger = createLogger('path-migration');

export function migratePaths(oldHome: string, newHome: string, dojoDir: string): void {
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
        updateTech.run(t.directory_path.replace(oldHome, newHome), t.id);
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
        updateConfig.run(c.value.replaceAll(oldHome, newHome), c.key);
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
        const newPromptPath = a.system_prompt_path?.replaceAll(oldHome, newHome) ?? null;
        const newConfig = a.config?.replaceAll(oldHome, newHome) ?? null;
        updateAgent.run(newPromptPath, newConfig, a.id);
      }
      if (agents.length > 0) {
        logger.info('Updated agent paths', { count: agents.length });
      }
    } catch { /* table may not exist */ }

    // Upload file paths in messages (attachments JSON)
    try {
      const msgs = db.prepare("SELECT id, attachments FROM messages WHERE attachments LIKE ?").all(`%${oldHome}%`) as Array<{ id: string; attachments: string }>;
      const updateMsg = db.prepare('UPDATE messages SET attachments = ? WHERE id = ?');
      for (const m of msgs) {
        updateMsg.run(m.attachments.replaceAll(oldHome, newHome), m.id);
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
    fs.writeFileSync(filePath, content.replaceAll(oldHome, newHome));
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
