// Path migration: rewrite home directory references after an import.

import fs from 'node:fs';
import path from 'node:path';
import { migrateDatabase } from './path-migration-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('path-migration');

/**
 * Replace `oldHome` with `newHome` only where it is a whole path prefix (followed by end of text, `/`,
 * whitespace, a quote or a JSON/YAML delimiter), so a folder that merely starts with the old home
 * (`<oldHome>x`, `<oldHome>-old`) is left alone. Both are literal: a `$` in newHome is never a pattern.
 */
export function swapHome(text: string, oldHome: string, newHome: string): string {
  if (!oldHome) return text;
  const escaped = oldHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?=$|[/\\s"'\`,;:)\\]}>\\\\])`, 'g'), () => newHome);
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

  migrateDatabase(oldHome, newHome, dojoDir);

  migrateTextFile(path.join(dojoDir, 'secrets.yaml'), oldHome, newHome);

  const configDir = path.join(dojoDir, 'config');
  if (fs.existsSync(configDir)) {
    migrateDirectory(configDir, oldHome, newHome);
  }

  const techniquesDir = path.join(dojoDir, 'techniques');
  if (fs.existsSync(techniquesDir)) {
    migrateDirectory(techniquesDir, oldHome, newHome);
  }

  // Cloudflare tunnel config (~/.cloudflared): config.yml names the credentials file by absolute path under
  // the old home, so it needs rewriting; the credentials .json holds no home paths and is left untouched.
  const cloudflaredDir = path.join(newHome, '.cloudflared');
  if (fs.existsSync(cloudflaredDir)) {
    migrateDirectory(cloudflaredDir, oldHome, newHome);
  }

  logger.info('Path migration complete');
}

function migrateTextFile(filePath: string, oldHome: string, newHome: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(filePath); } catch { return; }
  // A symlink may point anywhere, outside the dojo folder included; never write through one.
  if (st.isSymbolicLink() || !st.isFile()) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  if (content.includes(oldHome)) {
    const updated = swapHome(content, oldHome, newHome);
    if (updated !== content) {
      // Write beside it and rename over it, so a kill mid-write cannot truncate the file.
      const tmp = `${filePath}.${process.pid}.migrating.tmp`;
      try {
        fs.writeFileSync(tmp, updated, { mode: st.mode & 0o777 });
        fs.chmodSync(tmp, st.mode & 0o777);
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw err;
      }
    }
    logger.info('Updated paths in file', { file: path.basename(filePath) });
  }
}

function migrateDirectory(dirPath: string, oldHome: string, newHome: string): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a link out of the folder
    if (entry.isDirectory()) {
      migrateDirectory(fullPath, oldHome, newHome);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.txt', '.yaml', '.yml', '.json', '.toml', '.sh'].includes(ext)) {
        migrateTextFile(fullPath, oldHome, newHome);
      }
    }
  }
}
