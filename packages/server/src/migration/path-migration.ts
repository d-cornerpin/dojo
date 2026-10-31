// ════════════════════════════════════════
// Path Migration — update home directory references after import
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateDatabase } from './path-migration-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('path-migration');

/**
 * Replace `oldHome` with `newHome` in `text`, but only where `oldHome` is a whole
 * path prefix: it must be followed by the end of the text, a `/`, whitespace, a quote,
 * or a JSON/YAML delimiter. That is an allow-list of real path boundaries: a folder name
 * that merely STARTS with the old home (`<oldHome>x`, `<oldHome>-old`, `<oldHome>@corp`,
 * any non-ASCII letter) is left alone, whatever character it continues with. `oldHome` is
 * matched literally and `newHome` is inserted literally (a `$` in it is never read as a
 * pattern).
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
      // Only process text-like files
      const ext = path.extname(entry.name).toLowerCase();
      if (['.md', '.txt', '.yaml', '.yml', '.json', '.toml', '.sh'].includes(ext)) {
        migrateTextFile(fullPath, oldHome, newHome);
      }
    }
  }
}
