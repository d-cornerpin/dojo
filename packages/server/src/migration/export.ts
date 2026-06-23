// ════════════════════════════════════════
// Migration Export — database snapshot, file collection, encryption, zip
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { getDb, getDbPath } from '../db/connection.js';
import { generateManifest, type ExportManifest } from './manifest.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-export');

const DOJO_DIR = path.join(os.homedir(), '.dojo');
const GWS_DIR = path.join(os.homedir(), '.config', 'gws');

// Deny-list for the comprehensive ~/.dojo copy. Top-level entries we never
// export because they are installer/runtime APP CODE or assets (the target
// machine's own installer provides them), not user data:
//   platform/      — the live installed app (node_modules + dist), per-arch
//   watchdog/      — the installed watchdog daemon (node_modules + dist)
//   scripts/       — installer-provided helper scripts (start/stop/etc.)
//   tools/         — tool docs, regenerated on boot
//   bin/           — built binaries (e.g. imsg), per-arch, rebuilt on install
//   logs/          — runtime noise
//   dojologo.pdf   — installer-provided app icon
// Plus platform.backup-<version>/ dirs (the updater's full app-code backups;
// disposable, often many GB) — matched by prefix below.
//
// IMPORTANT: if the installer ever adds a NEW app-code dir under ~/.dojo, add it
// here AND to the import's preserve list. Everything else (user data) migrates
// automatically by design.
const TOP_LEVEL_SKIP = new Set(['platform', 'watchdog', 'scripts', 'tools', 'bin', 'logs', 'dojologo.pdf']);
const PLATFORM_BACKUP_PREFIX = 'platform.backup-';
// voice/ is mostly large, re-downloadable model weights (kokoro/moonshine/...).
// We migrate only the user's custom imports; the base models re-download on
// first use on the new machine.
const VOICE_KEEP_SUBDIR = 'custom';
// Files inside data/ we skip because the DB is snapshotted via the backup API
// (a raw copy of an open WAL database would be inconsistent). dojo.sqlite is an
// empty legacy artifact.
const DATA_FILE_SKIP = new Set(['dojo.db', 'dojo.db-shm', 'dojo.db-wal', 'dojo.sqlite']);
const JUNK = new Set(['.DS_Store']);

export interface ExportProgress {
  stage: string;
  progress: number;
  message: string;
}

function broadcastProgress(stage: string, progress: number, message: string): void {
  broadcast({
    type: 'migration:progress',
    data: { stage, progress, message },
  } as any);
}

// ── Encryption ──

// Stream-encrypt a file on disk to payload.enc, returning the sha256 of the
// whole output (salt+iv+ciphertext) for the manifest checksum. Streaming (not
// a single Buffer) is required: fs.readFileSync and crypto.update() both cap at
// 2^31-1 bytes, so a multi-GB inner archive can't go through them in one shot.
// Output layout: salt(32) | iv(16) | AES-256-CBC ciphertext.
async function encryptFileToFile(srcPath: string, destPath: string, password: string): Promise<string> {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const hash = crypto.createHash('sha256');

  const out = fs.createWriteStream(destPath);
  // The salt + IV are part of payload.enc and the checksum, written first.
  hash.update(salt);
  hash.update(iv);
  out.write(salt);
  out.write(iv);

  await pipeline(
    fs.createReadStream(srcPath),
    cipher,
    new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    out,
  );

  return hash.digest('hex');
}

// ── Directory Size ──

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

// ── List Files ──

function listFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
}

// ── Export ──

export async function createExport(password: string): Promise<{ filePath: string; manifest: ExportManifest }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-export-'));

  try {
    // Step 1: Database snapshot using better-sqlite3 backup API
    broadcastProgress('database', 10, 'Preparing database snapshot...');
    logger.info('Starting database snapshot');

    const db = getDb();
    const dbBackupPath = path.join(tmpDir, 'data', 'dojo.db');
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });

    await db.backup(dbBackupPath);
    const dbSize = fs.statSync(dbBackupPath).size;
    logger.info('Database snapshot complete', { size: dbSize });

    // Step 2: Comprehensive copy of ~/.dojo (DENY-LIST, not allow-list).
    // Everything in the dojo directory migrates so the new machine is the exact
    // same dojo — prompts, techniques (with their files + dependency manifests),
    // uploads + all generated media, the memory file cache, custom voice imports,
    // the imessage archive, receipts, canvas screenshots, secrets.yaml, config,
    // and anything added in the future. We skip only:
    //   - tools/  (re-created by the dojo installer on the target machine)
    //   - logs/   (machine-local runtime noise)
    //   - the live DB files in data/ (snapshotted above via the backup API)
    // We also skip the installed app code (platform/) and the updater's
    // platform.backup-<version>/ dirs — that's per-machine app code, not user
    // data, and would add gigabytes. Using a deny-list is deliberate: new user
    // folders are picked up automatically, so this never falls behind.
    broadcastProgress('files', 40, 'Packaging your dojo...');
    copyDojoTree(DOJO_DIR, tmpDir);
    logger.info('Dojo tree copied (deny-list)');

    // Step 3: Google Workspace auth lives OUTSIDE ~/.dojo (legacy ~/.config/gws).
    if (fs.existsSync(GWS_DIR)) {
      copyDirRecursive(GWS_DIR, path.join(tmpDir, 'gws'));
    }

    // Step 3b: Generate the technique-dependency installer. It travels in the
    // archive (setup-dependencies.sh) so the new machine can one-click install
    // the external tools techniques rely on. Generated from the structured
    // dependency manifests only (injection-safe).
    try {
      const { generateDependencySetupScript } = await import('./dependency-script.js');
      const dep = generateDependencySetupScript(new Date().toISOString());
      if (dep.script) {
        fs.writeFileSync(path.join(tmpDir, 'setup-dependencies.sh'), dep.script, { mode: 0o755 });
        logger.info('Dependency setup script bundled', {
          techniqueCount: dep.techniqueCount, stepCount: dep.stepCount,
        });
      }
    } catch (err) {
      logger.warn('Dependency setup script generation failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 4: Generate manifest (descriptive summary of what's inside).
    broadcastProgress('manifest', 60, 'Generating manifest...');
    const promptFiles = listFiles(path.join(DOJO_DIR, 'prompts'));
    const techniqueNames = listTechniqueNames();
    const uploadsSize = getDirSize(path.join(DOJO_DIR, 'uploads'));
    const manifest = generateManifest(dbSize, promptFiles, techniqueNames, uploadsSize);

    // Step 9: Create inner archive (everything except manifest)
    broadcastProgress('archive', 70, 'Creating archive...');
    const innerZipPath = path.join(tmpDir, '_inner.zip');
    await createZipFromDir(tmpDir, innerZipPath, ['_inner.zip']);

    // Step 10+11: Stream-encrypt the inner archive to payload.enc and compute
    // its checksum in the same pass (no whole-file Buffer — see encryptFileToFile).
    broadcastProgress('encrypt', 80, 'Encrypting archive...');
    const payloadEncPath = path.join(tmpDir, 'payload.enc');
    const checksum = await encryptFileToFile(innerZipPath, payloadEncPath, password);
    manifest.checksum = `sha256:${checksum}`;

    // Step 12: Create final zip with manifest (unencrypted) + encrypted payload
    // (streamed from disk, not buffered).
    const date = new Date().toISOString().split('T')[0];
    const outputPath = path.join(os.tmpdir(), `dojo-export-${date}.zip`);
    await createFinalZip(outputPath, manifest, payloadEncPath);

    broadcastProgress('complete', 100, 'Export complete!');
    logger.info('Export complete', { outputPath, size: fs.statSync(outputPath).size });

    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { filePath: outputPath, manifest };
  } catch (err) {
    // Cleanup on error
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ── Helpers ──

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (JUNK.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Copy the entire ~/.dojo tree into the export staging dir, applying the
// deny-list: skip tools/ and logs/ at the top level, and skip the live DB
// files inside data/ (the consistent snapshot is written separately). The DB
// snapshot is written to <dest>/data/dojo.db before this runs, so the data/
// copy here just merges the rest (files/, canvas-shots/, slides_styles.json…).
function copyDojoTree(srcRoot: string, destRoot: string): void {
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (JUNK.has(entry.name) || TOP_LEVEL_SKIP.has(entry.name)) continue;
    if (entry.name.startsWith(PLATFORM_BACKUP_PREFIX)) continue; // disposable update backups
    const src = path.join(srcRoot, entry.name);
    const dest = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'data') {
        copyDirRecursiveExcept(src, dest, DATA_FILE_SKIP);
      } else if (entry.name === 'voice') {
        // Only the user's custom voice imports; skip the re-downloadable models.
        const customSrc = path.join(src, VOICE_KEEP_SUBDIR);
        if (fs.existsSync(customSrc)) {
          copyDirRecursive(customSrc, path.join(dest, VOICE_KEEP_SUBDIR));
        }
      } else {
        copyDirRecursive(src, dest);
      }
    } else {
      fs.mkdirSync(destRoot, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

// Like copyDirRecursive but skips the given top-level names (used for data/ to
// exclude the live DB files).
function copyDirRecursiveExcept(src: string, dest: string, skipTopLevel: Set<string>): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (JUNK.has(entry.name) || skipTopLevel.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Technique directory names (for the manifest summary).
function listTechniqueNames(): string[] {
  const dir = path.join(DOJO_DIR, 'techniques');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => {
    try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
  });
}

function createZipFromDir(dirPath: string, outputPath: string, exclude: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        archive.directory(fullPath, entry.name);
      } else {
        archive.file(fullPath, { name: entry.name });
      }
    }

    archive.finalize();
  });
}

function createFinalZip(outputPath: string, manifest: ExportManifest, payloadEncPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 1 } }); // light compression, payload already compressed

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Manifest is unencrypted and first in the zip
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Encrypted payload, streamed from disk (never buffered whole)
    archive.file(payloadEncPath, { name: 'payload.enc' });

    archive.finalize();
  });
}
