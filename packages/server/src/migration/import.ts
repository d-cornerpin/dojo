// ════════════════════════════════════════
// Migration Import — decrypt, verify, restore, path migration
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { closeDb } from '../db/connection.js';
import { clearSecretsCache } from '../config/loader.js';
import { migratePaths } from './path-migration.js';
import { runPostMigrationChecks, type PostMigrationCheck } from './checks.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import type { ExportManifest } from './manifest.js';

const logger = createLogger('migration-import');

const DOJO_DIR = path.join(os.homedir(), '.dojo');
const GWS_DIR = path.join(os.homedir(), '.config', 'gws');

function broadcastProgress(stage: string, progress: number, message: string): void {
  broadcast({
    type: 'migration:progress',
    data: { stage, progress, message },
  } as any);
}

// ── Decryption ──

function decryptBuffer(data: Buffer, password: string): Buffer {
  const salt = data.subarray(0, 32);
  const iv = data.subarray(32, 48);
  const encrypted = data.subarray(48);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ── Read Manifest from Zip (no password needed) ──

export function readManifestFromZip(zipBuffer: Buffer): ExportManifest {
  const zip = new AdmZip(zipBuffer);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new Error('Invalid export file: no manifest.json found');
  }
  return JSON.parse(manifestEntry.getData().toString('utf-8'));
}

// ── Import ──

export async function performImport(
  zipBuffer: Buffer,
  password: string,
  stopServices: () => Promise<void>,
  restartServices: () => Promise<void>,
  /** Current password hash and JWT secret to preserve after import */
  currentAuth?: { passwordHash: string | null; jwtSecret: string },
): Promise<{ manifest: ExportManifest; checks: PostMigrationCheck[]; newToken?: string }> {
  // Step 1: Read manifest
  broadcastProgress('manifest', 5, 'Reading manifest...');
  const manifest = readManifestFromZip(zipBuffer);
  logger.info('Import started', {
    from: manifest.exported_from.hostname,
    agents: manifest.contents.agents_count,
    techniques: manifest.contents.techniques_count,
  });

  // Step 2: Extract encrypted payload
  broadcastProgress('decrypt', 15, 'Decrypting archive...');
  const outerZip = new AdmZip(zipBuffer);
  const payloadEntry = outerZip.getEntry('payload.enc');
  if (!payloadEntry) {
    throw new Error('Invalid export file: no encrypted payload found');
  }

  let decrypted: Buffer;
  try {
    decrypted = decryptBuffer(payloadEntry.getData(), password);
  } catch (err) {
    throw new Error('Wrong password or corrupted archive');
  }

  // Step 3: Verify checksum
  broadcastProgress('verify', 25, 'Verifying checksum...');
  const expectedChecksum = manifest.checksum.replace('sha256:', '');
  const actualChecksum = crypto.createHash('sha256').update(payloadEntry.getData()).digest('hex');
  if (expectedChecksum !== actualChecksum) {
    throw new Error('Archive corrupted: checksum mismatch');
  }
  logger.info('Checksum verified');

  // Step 4: Extract inner zip to temp dir
  broadcastProgress('extract', 35, 'Extracting files...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-import-'));

  try {
    const innerZip = new AdmZip(decrypted);
    innerZip.extractAllTo(tmpDir, true);

    // Step 5: Stop services
    broadcastProgress('services', 45, 'Stopping services...');
    await stopServices();

    // Close database connection so we can replace the file
    closeDb();

    // Step 6: Backup current ~/.dojo/
    broadcastProgress('backup', 50, 'Backing up current dojo...');
    const timestamp = Date.now();
    const backupDir = `${DOJO_DIR}-backup-${timestamp}`;
    if (fs.existsSync(DOJO_DIR)) {
      fs.renameSync(DOJO_DIR, backupDir);
      logger.info('Current dojo backed up', { backupDir });
    }

    // Recreate dojo dir
    fs.mkdirSync(DOJO_DIR, { recursive: true });

    // Step 7: Restore database
    broadcastProgress('database', 60, 'Restoring database...');
    const srcDb = path.join(tmpDir, 'data', 'dojo.db');
    if (fs.existsSync(srcDb)) {
      const destDb = path.join(DOJO_DIR, 'data');
      fs.mkdirSync(destDb, { recursive: true });
      fs.copyFileSync(srcDb, path.join(destDb, 'dojo.db'));
      // Also copy WAL/SHM if they exist
      for (const ext of ['-wal', '-shm']) {
        const walPath = path.join(tmpDir, 'data', `dojo.db${ext}`);
        if (fs.existsSync(walPath)) {
          fs.copyFileSync(walPath, path.join(destDb, `dojo.db${ext}`));
        }
      }

      // Restore large file cache (memory system)
      const srcFiles = path.join(tmpDir, 'data', 'files');
      if (fs.existsSync(srcFiles)) {
        copyDirRecursive(srcFiles, path.join(destDb, 'files'));
      }
    }

    // Step 8: Restore prompts
    broadcastProgress('prompts', 70, 'Restoring prompts and techniques...');
    const srcPrompts = path.join(tmpDir, 'prompts');
    if (fs.existsSync(srcPrompts)) {
      copyDirRecursive(srcPrompts, path.join(DOJO_DIR, 'prompts'));
    }

    // Step 9: Restore techniques
    const srcTech = path.join(tmpDir, 'techniques');
    if (fs.existsSync(srcTech)) {
      copyDirRecursive(srcTech, path.join(DOJO_DIR, 'techniques'));
    }

    // Step 10: Restore uploads
    const srcUploads = path.join(tmpDir, 'uploads');
    if (fs.existsSync(srcUploads)) {
      copyDirRecursive(srcUploads, path.join(DOJO_DIR, 'uploads'));
    }

    // Step 11: Restore secrets
    broadcastProgress('config', 80, 'Restoring configuration...');
    const srcSecrets = path.join(tmpDir, 'secrets.yaml');
    if (fs.existsSync(srcSecrets)) {
      fs.copyFileSync(srcSecrets, path.join(DOJO_DIR, 'secrets.yaml'));
      fs.chmodSync(path.join(DOJO_DIR, 'secrets.yaml'), 0o600);
    }

    // Step 12: Restore config directory
    const srcConfig = path.join(tmpDir, 'config');
    if (fs.existsSync(srcConfig)) {
      copyDirRecursive(srcConfig, path.join(DOJO_DIR, 'config'));
    }

    // Step 13: Restore Google Workspace auth
    const srcGws = path.join(tmpDir, 'gws');
    if (fs.existsSync(srcGws)) {
      copyDirRecursive(srcGws, GWS_DIR);
    }

    // Recreate logs directory
    fs.mkdirSync(path.join(DOJO_DIR, 'logs'), { recursive: true });

    // Step 14: Path migration
    broadcastProgress('paths', 85, 'Updating paths for this machine...');
    const oldHome = manifest.exported_from.home_directory;
    const newHome = os.homedir();
    migratePaths(oldHome, newHome, DOJO_DIR);

    // Clear all caches so they reload from the restored files
    clearSecretsCache();
    const { clearPlatformConfigCache } = await import('../config/platform.js');
    clearPlatformConfigCache();

    // Step 14b: Preserve the current session's auth (password + JWT secret)
    // so the user doesn't get logged out after import
    if (currentAuth) {
      const { loadSecrets, saveSecrets } = await import('../config/loader.js');
      const restoredSecrets = loadSecrets();
      // Keep the current JWT secret so the active session token remains valid
      restoredSecrets.jwt_secret = currentAuth.jwtSecret;
      // Keep the current password hash so the user can log in with the password they just set
      if (currentAuth.passwordHash) {
        restoredSecrets.dashboard_password_hash = currentAuth.passwordHash;
      }
      saveSecrets(restoredSecrets);
      logger.info('Preserved current session auth in restored secrets');
    }

    // Step 15: Mark OOBE as completed
    markOobeComplete();

    // Step 16: Restart services
    broadcastProgress('restart', 90, 'Restarting services...');
    await restartServices();

    // Step 17: Run post-migration checks
    broadcastProgress('checks', 95, 'Checking dependencies...');
    const checks = await runPostMigrationChecks(manifest);

    broadcastProgress('complete', 100, 'Import complete!');
    logger.info('Import complete');

    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { manifest, checks };
  } catch (err) {
    // On failure, try to restore the backup
    const backupDir = `${DOJO_DIR}-backup-${Date.now()}`;
    // The actual backup was made with a specific timestamp — find it
    try {
      const parentDir = path.dirname(DOJO_DIR);
      const backups = fs.readdirSync(parentDir).filter(f => f.startsWith('.dojo-backup-'));
      if (backups.length > 0) {
        const latestBackup = path.join(parentDir, backups.sort().pop()!);
        if (fs.existsSync(DOJO_DIR)) {
          fs.rmSync(DOJO_DIR, { recursive: true, force: true });
        }
        fs.renameSync(latestBackup, DOJO_DIR);
        logger.info('Restored backup after failed import');
      }
    } catch (restoreErr) {
      logger.error('Failed to restore backup', { error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr) });
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ── Helpers ──

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function markOobeComplete(): void {
  // Open the restored database directly (main connection is closed during import)
  const dbPath = path.join(DOJO_DIR, 'data', 'dojo.db');
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_complete', 'true')").run();
    // Also mark in 'config' table which is what the OOBE checks
    try {
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
    } catch { /* table may not exist */ }
  } finally {
    db.close();
  }
}
