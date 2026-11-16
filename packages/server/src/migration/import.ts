// Migration import: decrypt, verify, restore and migrate paths.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import Database from 'better-sqlite3';
import { closeDb } from '../db/connection.js';
import { migrationAheadOfBuild } from '../db/migrations.js';
import { clearSecretsCache } from '../config/loader.js';
import { migratePaths } from './path-migration.js';
import { copyTree } from './fs-copy.js';
import { restartAfterFailedImport, noteBackupStuck, clearImportCard } from './import-recovery.js';
import { putBackOwnBackup, acquireImportLock } from './import-safety.js';
import { runPostMigrationChecks, setLastManifest, type PostMigrationCheck } from './checks.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import type { ExportManifest } from './manifest.js';
import { homeDir } from '../home.js';

const logger = createLogger('migration-import');

const DOJO_DIR = path.join(homeDir(), '.dojo');
const GWS_DIR = path.join(homeDir(), '.config', 'gws');
// Restores to ~/.cloudflared (mirror of the export's CLOUDFLARED_DIR); outside ~/.dojo, routed like gws.
const CLOUDFLARED_DIR = path.join(homeDir(), '.cloudflared');

function broadcastProgress(stage: string, progress: number, message: string): void {
  broadcast({
    type: 'migration:progress',
    data: { stage, progress, message },
  });
}


// Takes a PATH to the zip. unzipper's seek-based reader pulls only the small manifest.json, so a multi-GB
// export is never read whole (adm-zip would readFileSync the archive; fs reads and crypto.update() cap at
// 2^31-1 bytes).
export async function readManifestFromZip(zipPath: string): Promise<ExportManifest> {
  const dir = await unzipper.Open.file(zipPath);
  const manifestEntry = dir.files.find((f) => f.path === 'manifest.json');
  if (!manifestEntry) {
    throw new Error('Invalid export file: no manifest.json found');
  }
  const buf = await manifestEntry.buffer();
  return JSON.parse(buf.toString('utf-8'));
}

// The wizard's scan step, no mutation: confirm the archive is intact and the password right before touching
// ~/.dojo. Streams payload.enc to a temp file, verifies its sha256, then decrypts a short prefix and checks
// for the "PK" zip header.
export async function verifyArchive(
  zipPath: string,
  password: string,
): Promise<{ manifest: ExportManifest; integrityOk: boolean; passwordOk: boolean }> {
  const manifest = await readManifestFromZip(zipPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-verify-'));
  const payloadPath = path.join(tmpDir, 'payload.enc');
  try {
    const outerDir = await unzipper.Open.file(zipPath);
    const payloadEntry = outerDir.files.find((f) => f.path === 'payload.enc');
    if (!payloadEntry) {
      throw new Error('Invalid export file: no encrypted payload found');
    }
    const hash = crypto.createHash('sha256');
    await pipeline(
      payloadEntry.stream(),
      new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } }),
      fs.createWriteStream(payloadPath),
    );
    const expected = manifest.checksum.replace('sha256:', '');
    const integrityOk = hash.digest('hex') === expected;

    // Cheap password check: decrypt only the first cipher blocks (autopadding off, so the final block is never
    // touched). The right key gives plaintext starting "PK\x03\x04"; a wrong password gives garbage.
    let passwordOk = false;
    if (integrityOk) {
      const header = Buffer.alloc(48);
      const cipherPrefix = Buffer.alloc(64);
      const fd = fs.openSync(payloadPath, 'r');
      try {
        fs.readSync(fd, header, 0, 48, 0);
        fs.readSync(fd, cipherPrefix, 0, 64, 48);
      } finally {
        fs.closeSync(fd);
      }
      const salt = header.subarray(0, 32);
      const iv = header.subarray(32, 48);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
      try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        decipher.setAutoPadding(false);
        const out = decipher.update(cipherPrefix);
        passwordOk = out.length >= 2 && out[0] === 0x50 && out[1] === 0x4b; // "PK"
      } catch {
        passwordOk = false;
      }
    }
    return { manifest, integrityOk, passwordOk };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


async function runImport(
  // PATH to the export zip on disk (see readManifestFromZip on why not a Buffer).
  zipPath: string,
  password: string,
  stopServices: () => Promise<void>,
  restartServices: () => Promise<void>,
  currentAuth?: { passwordHash: string | null; jwtSecret: string },
  /** Called when a failed import's data is back and services restarted: resumes the agents it stopped. */
  resumeAfterFailure?: () => void,
): Promise<{ manifest: ExportManifest; checks: PostMigrationCheck[]; newToken?: string }> {
  // The whole pipeline streams (unzipper, streaming crypto, intermediates on disk in tmpDir): a multi-GB
  // export is never held in one Buffer.

  broadcastProgress('manifest', 5, 'Reading manifest...');
  const manifest = await readManifestFromZip(zipPath);
  logger.info('Import started', {
    from: manifest.exported_from.hostname,
    agents: manifest.contents.agents_count,
    techniques: manifest.contents.techniques_count,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-import-'));
  const extractRoot = path.join(tmpDir, 'extracted');

  // Only the backup THIS run makes may be restored on failure: reaching for an older `.dojo-backup-*` from
  // an earlier run would delete the live ~/.dojo.
  let ownBackup: string | null = null;
  let servicesStopped = false; // a failure after stop must put the old tree back and restart onto it

  try {
    // Stream the encrypted payload to disk, hashing as it flows so the checksum needs no buffering.
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

    // Verify the checksum over the full payload.enc bytes (salt+iv+ciphertext).
    broadcastProgress('verify', 22, 'Verifying checksum...');
    const expectedChecksum = manifest.checksum.replace('sha256:', '');
    const actualChecksum = hash.digest('hex');
    if (expectedChecksum !== actualChecksum) {
      throw new Error('Archive corrupted: checksum mismatch');
    }
    logger.info('Checksum verified');

    // Stream-decrypt payload.enc to the inner zip. Layout: salt(32) | iv(16) | AES-256-CBC ciphertext.
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

    // Extract the inner zip, streaming each entry to disk.
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

    // A database a newer Dojo changed cannot be read by this build: refuse before anything is stopped.
    const snapshot = path.join(extractRoot, 'data', 'dojo.db');
    const sdb = fs.existsSync(snapshot) ? new Database(snapshot, { readonly: true }) : null;
    let ahead: string | null;
    try { ahead = sdb && migrationAheadOfBuild(sdb); } finally { sdb?.close(); }
    if (ahead) throw new Error(`This export's data holds a change (${ahead}) this version of Dojo does not have, so it cannot read it. Update this Dojo first, then import it. Nothing was changed.`);

    broadcastProgress('services', 45, 'Stopping services...');
    servicesStopped = true;
    await stopServices();

    // Close the database so its file can be replaced.
    closeDb();

    broadcastProgress('backup', 50, 'Backing up current dojo...');
    const timestamp = Date.now();
    const backupDir = `${DOJO_DIR}-backup-${timestamp}`;
    if (fs.existsSync(DOJO_DIR)) {
      fs.renameSync(DOJO_DIR, backupDir);
      ownBackup = backupDir;
      logger.info('Current dojo backed up', { backupDir });
    }

    fs.mkdirSync(DOJO_DIR, { recursive: true });

    // Restore the entire dojo tree: the payload mirrors ~/.dojo (minus tools/ and logs/, with a consistent DB
    // snapshot at data/dojo.db). gws/ and cloudflared/ belong outside ~/.dojo and are routed below.
    broadcastProgress('database', 60, 'Restoring your dojo...');
    for (const entry of fs.readdirSync(extractRoot, { withFileTypes: true })) {
      if (entry.name === 'gws') continue; // belongs at ~/.config/gws (below)
      if (entry.name === 'cloudflared') continue; // belongs at ~/.cloudflared (below)
      const src = path.join(extractRoot, entry.name);
      const dest = path.join(DOJO_DIR, entry.name);
      copyTree(src, dest);
    }

    // Google Workspace auth lives at ~/.config/gws.
    const srcGws = path.join(extractRoot, 'gws');
    if (fs.existsSync(srcGws)) {
      copyTree(srcGws, GWS_DIR);
    }

    // Restore the Cloudflare tunnel setup (~/.cloudflared). Zip transport drops file modes and cloudflared
    // refuses world-readable credentials, so the .pem and .json files are set to 0600.
    const srcCloudflared = path.join(extractRoot, 'cloudflared');
    if (fs.existsSync(srcCloudflared)) {
      copyTree(srcCloudflared, CLOUDFLARED_DIR);
      for (const f of fs.readdirSync(CLOUDFLARED_DIR)) {
        if (f.endsWith('.pem') || f.endsWith('.json')) {
          try { fs.chmodSync(path.join(CLOUDFLARED_DIR, f), 0o600); } catch { /* non-fatal */ }
        }
      }
      logger.info('Cloudflare tunnel config restored');
    }

    // Preserve this machine's installer/runtime app code from the pre-import backup (the export omits it and
    // ~/.dojo was recreated fresh): platform, watchdog, scripts, tools, bin, dojologo.pdf. platform.backup-*
    // dirs and voice models are deliberately not restored.
    broadcastProgress('config', 80, 'Finalizing configuration...');
    if (backupDir && fs.existsSync(backupDir)) {
      for (const appItem of ['platform', 'watchdog', 'scripts', 'tools', 'bin', 'dojologo.pdf']) {
        const src = path.join(backupDir, appItem);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(DOJO_DIR, appItem);
        // copyTree keeps the node_modules workspace symlinks intact.
        copyTree(src, dest);
      }
    }

    // Lock down secrets.yaml (restored with the tree).
    const restoredSecretsPath = path.join(DOJO_DIR, 'secrets.yaml');
    if (fs.existsSync(restoredSecretsPath)) {
      fs.chmodSync(restoredSecretsPath, 0o600);
    }

    // Make the bundled dependency installer executable (zip transport may drop the mode).
    const depScriptPath = path.join(DOJO_DIR, 'setup-dependencies.sh');
    if (fs.existsSync(depScriptPath)) {
      try { fs.chmodSync(depScriptPath, 0o755); } catch { /* non-fatal */ }
    }

    fs.mkdirSync(path.join(DOJO_DIR, 'logs'), { recursive: true });

    broadcastProgress('paths', 85, 'Updating paths for this machine...');
    const oldHome = manifest.exported_from.home_directory;
    const newHome = homeDir();
    migratePaths(oldHome, newHome, DOJO_DIR);

    // Clear caches so they reload from the restored files.
    clearSecretsCache();

    // Preserve the current session's auth (password and JWT secret) so the user stays logged in.
    if (currentAuth) {
      const { loadSecrets, saveSecrets } = await import('../config/loader.js');
      const restoredSecrets = loadSecrets();
      restoredSecrets.jwt_secret = currentAuth.jwtSecret;
      if (currentAuth.passwordHash) {
        restoredSecrets.dashboard_password_hash = currentAuth.passwordHash;
      }
      saveSecrets(restoredSecrets);
      logger.info('Preserved current session auth in restored secrets');
    }

    markOobeComplete();

    broadcastProgress('restart', 90, 'Restarting services...');
    await restartServices();   // from here the import is COMMITTED: nothing below rolls it back
    (await import('../config/platform.js')).clearPlatformConfigCache();   // after the migrations, so a renamed key is not read stale
    clearImportCard();

    // Post-migration checks (manifest cached first for later re-checks). The import is committed: a failure
    // here is logged, never rolled back.
    let checks: PostMigrationCheck[] = [];
    try {
      setLastManifest(manifest);
      broadcastProgress('checks', 95, 'Checking dependencies...');
      checks = await runPostMigrationChecks(manifest);
      broadcastProgress('complete', 100, 'Import complete!');
    } catch (postErr) { logger.error('Post-import checks failed after a good import', { error: String(postErr) }); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp only */ }
    logger.info('Import complete');
    return { manifest, checks };
  } catch (err) {
    if (servicesStopped) { try { closeDb(); } catch { /* already closed */ } } // before the tree under it is swapped
    let stuck: string | null = null; // owner words when the data could not be put back: do NOT restart
    const back = ownBackup && fs.existsSync(ownBackup) ? putBackOwnBackup(fs, DOJO_DIR, ownBackup) : null;
    if (back && !back.ok) { logger.error('Failed to restore backup', { error: back.reason }); stuck = noteBackupStuck(back.backup); }
    stuck ??= await restartAfterFailedImport({ servicesStopped, restartServices });
    if (stuck === null && servicesStopped) { try { resumeAfterFailure?.(); } catch (e) { logger.error('Could not resume the agents a failed import stopped', { error: String(e) }); } }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (stuck !== null) throw new Error(`${err instanceof Error ? err.message : String(err)} ${stuck}`, { cause: err });
    throw err;
  }
}

/** One import at a time: a second one is refused (ImportAlreadyRunningError) before it touches anything. */
export async function performImport(...args: Parameters<typeof runImport>): ReturnType<typeof runImport> {
  const release = acquireImportLock(fs, path.join(homeDir(), '.dojo-import.lock'));
  try { return await runImport(...args); } finally { release(); }
}


function markOobeComplete(): void {
  // Open the restored database directly (main connection is closed during import)
  const dbPath = path.join(DOJO_DIR, 'data', 'dojo.db');
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    // One key, the one every reader uses.
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('setup_completed', 'true')").run();
  } finally {
    db.close();
  }
}
