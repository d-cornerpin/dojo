// ════════════════════════════════════════
// Migration Import — decrypt, verify, restore, path migration
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
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

// ── Read Manifest from Zip (no password needed) ──

// Takes a PATH to the export zip on disk. Uses unzipper's seek-based reader,
// which reads the central directory via fd seeks and only pulls the (small)
// manifest.json entry — so a multi-GB export is never read into memory as a
// single Buffer. (adm-zip can't do this: it fs.readFileSync()s the whole
// archive, and both fs reads and crypto.update() cap out at 2^31-1 bytes.)
export async function readManifestFromZip(zipPath: string): Promise<ExportManifest> {
  const dir = await unzipper.Open.file(zipPath);
  const manifestEntry = dir.files.find((f) => f.path === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('Invalid export file: no manifest.json found');
  }
  const buf = await manifestEntry.buffer();
  return JSON.parse(buf.toString('utf-8'));
}

// ── Import ──

export async function performImport(
  // PATH to the export zip on disk (see readManifestFromZip on why not a Buffer).
  zipPath: string,
  password: string,
  stopServices: () => Promise<void>,
  restartServices: () => Promise<void>,
  /** Current password hash and JWT secret to preserve after import */
  currentAuth?: { passwordHash: string | null; jwtSecret: string },
): Promise<{ manifest: ExportManifest; checks: PostMigrationCheck[]; newToken?: string }> {
  // The whole pipeline streams: a multi-GB export must never be held in a
  // single Buffer. We use unzipper (seek-based, streams entries) and streaming
  // crypto, staging intermediates on disk in tmpDir.

  // Step 1: Read manifest (seek-reads just manifest.json)
  broadcastProgress('manifest', 5, 'Reading manifest...');
  const manifest = await readManifestFromZip(zipPath);
  logger.info('Import started', {
    from: manifest.exported_from.hostname,
    agents: manifest.contents.agents_count,
    techniques: manifest.contents.techniques_count,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-import-'));
  // Where the decrypted inner zip is unpacked; the restore below reads this.
  const extractRoot = path.join(tmpDir, 'extracted');

  try {
    // Step 2: Stream the encrypted payload out of the outer zip to disk,
    // hashing it as it flows so the checksum is verified without buffering it.
    broadcastProgress('decrypt', 12, 'Reading encrypted payload...');
    const outerDir = await unzipper.Open.file(zipPath);
    const payloadEntry = outerDir.files.find((f) => f.path === 'payload.enc');
    if (!payloadEntry) {
      throw new Error('Invalid export file: no encrypted payload found');
    }
    const payloadPath = path.join(tmpDir, 'payload.enc');
    const hash = crypto.createHash('sha256');
    await pipeline(
      payloadEntry.stream(),
      new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      fs.createWriteStream(payloadPath),
    );

    // Step 3: Verify checksum (over the full payload.enc bytes: salt+iv+ciphertext)
    broadcastProgress('verify', 22, 'Verifying checksum...');
    const expectedChecksum = manifest.checksum.replace('sha256:', '');
    const actualChecksum = hash.digest('hex');
    if (expectedChecksum !== actualChecksum) {
      throw new Error('Archive corrupted: checksum mismatch');
    }
    logger.info('Checksum verified');

    // Step 4: Stream-decrypt payload.enc → the inner zip on disk.
    // Layout: salt(32) | iv(16) | AES-256-CBC ciphertext.
    broadcastProgress('decrypt', 28, 'Decrypting archive...');
    const header = Buffer.alloc(48);
    const fd = fs.openSync(payloadPath, 'r');
    try {
      fs.readSync(fd, header, 0, 48, 0);
    } finally {
      fs.closeSync(fd);
    }
    const salt = header.subarray(0, 32);
    const iv = header.subarray(32, 48);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const innerZipPath = path.join(tmpDir, '_inner.zip');
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      await pipeline(
        fs.createReadStream(payloadPath, { start: 48 }),
        decipher,
        fs.createWriteStream(innerZipPath),
      );
    } catch (err) {
      // Bad PKCS padding at decipher.final() ⇒ wrong password (or corruption).
      throw new Error('Wrong password or corrupted archive');
    }
    fs.rmSync(payloadPath, { force: true });

    // Step 5: Extract the inner zip — seek-based, streaming each entry to disk
    // so even a multi-GB entry never buffers whole.
    broadcastProgress('extract', 35, 'Extracting files...');
    fs.mkdirSync(extractRoot, { recursive: true });
    const innerDir = await unzipper.Open.file(innerZipPath);
    for (const file of innerDir.files) {
      const dest = path.join(extractRoot, file.path);
      // zip-slip guard: every entry must resolve inside extractRoot.
      if (dest !== extractRoot && !dest.startsWith(extractRoot + path.sep)) {
        throw new Error(`Unsafe path in archive: ${file.path}`);
      }
      if (file.type === 'Directory') {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(file.stream(), fs.createWriteStream(dest));
    }
    fs.rmSync(innerZipPath, { force: true });

    // Step 5b: Stop services
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

    // Step 7: Restore the ENTIRE dojo tree. The payload mirrors ~/.dojo (minus
    // the installer's tools/ and logs/, and with a consistent DB snapshot in
    // data/dojo.db), so we copy it all in — database, prompts, techniques,
    // uploads + generated media, voice, the imessage archive, receipts, config,
    // secrets.yaml, and anything else. The one entry that belongs OUTSIDE
    // ~/.dojo is gws/, routed separately below.
    broadcastProgress('database', 60, 'Restoring your dojo...');
    for (const entry of fs.readdirSync(extractRoot, { withFileTypes: true })) {
      if (entry.name === 'gws') continue; // belongs at ~/.config/gws (below)
      const src = path.join(extractRoot, entry.name);
      const dest = path.join(DOJO_DIR, entry.name);
      if (entry.isDirectory()) {
        copyDirRecursive(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
    }

    // Step 8: Restore Google Workspace auth (lives at ~/.config/gws).
    const srcGws = path.join(extractRoot, 'gws');
    if (fs.existsSync(srcGws)) {
      copyDirRecursive(srcGws, GWS_DIR);
    }

    // Step 9: Preserve THIS machine's installer/runtime app code + assets from
    // the pre-import backup. The export omits these (they're per-machine app
    // code, mirror of the export deny-list), and we recreated ~/.dojo fresh, so
    // without this the new machine's running install would be gone after restart:
    //   platform/ — the live app (node_modules + dist); the app self-updates and
    //               runs from ~/.dojo/platform in production.
    //   watchdog/ — the installed watchdog daemon.
    //   scripts/  — installer helper scripts (start/stop/status/uninstall).
    //   tools/    — tool docs.
    //   bin/      — built binaries (imsg), per-arch.
    //   dojologo.pdf — app icon.
    // platform.backup-* dirs are intentionally NOT restored (disposable update
    // history). Voice models are not restored either (they re-download on use).
    broadcastProgress('config', 80, 'Finalizing configuration...');
    if (backupDir && fs.existsSync(backupDir)) {
      for (const appItem of ['platform', 'watchdog', 'scripts', 'tools', 'bin', 'dojologo.pdf']) {
        const src = path.join(backupDir, appItem);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(DOJO_DIR, appItem);
        if (fs.statSync(src).isDirectory()) copyDirRecursive(src, dest);
        else fs.copyFileSync(src, dest);
      }
    }

    // Step 10: Lock down secrets.yaml (restored as part of the tree above).
    const restoredSecretsPath = path.join(DOJO_DIR, 'secrets.yaml');
    if (fs.existsSync(restoredSecretsPath)) {
      fs.chmodSync(restoredSecretsPath, 0o600);
    }

    // Make the bundled technique-dependency installer executable (zip transport
    // may not preserve the mode). The wizard runs it on user click.
    const depScriptPath = path.join(DOJO_DIR, 'setup-dependencies.sh');
    if (fs.existsSync(depScriptPath)) {
      try { fs.chmodSync(depScriptPath, 0o755); } catch { /* non-fatal */ }
    }

    // Recreate logs directory (not exported).
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
