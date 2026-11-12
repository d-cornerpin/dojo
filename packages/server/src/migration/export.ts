// Migration export: database snapshot, file collection, encryption and zip.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { getDb, getDbPath } from '../db/connection.js';
import { copyTree } from './fs-copy.js';
import { generateManifest, type ExportManifest } from './manifest.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { homeDir } from '../home.js';
import { TOOLBOX_LEDGER_FILE } from '../agent/effects/toolbox-ledger.js';

const logger = createLogger('migration-export');

const DOJO_DIR = path.join(homeDir(), '.dojo');
const GWS_DIR = path.join(homeDir(), '.config', 'gws');
// Cloudflare tunnel setup lives outside ~/.dojo: the account cert, the named-tunnel credentials file
// (the tunnel key) and config.yml. A cert/credentials setup needs this directory to run on the new
// machine. Travels as cloudflared/.
const CLOUDFLARED_DIR = path.join(homeDir(), '.cloudflared');

// Deny-list for the ~/.dojo copy: top-level app code and assets the target machine's installer
// provides (platform, watchdog, scripts, tools, bin, logs, dojologo.pdf), plus platform.backup-* dirs
// matched by prefix. A new app-code dir under ~/.dojo must be added here AND to the import's preserve list.
const TOP_LEVEL_SKIP = new Set(['platform', 'watchdog', 'scripts', 'tools', 'bin', 'logs', 'dojologo.pdf']);
const PLATFORM_BACKUP_PREFIX = 'platform.backup-';
// voice/ is mostly re-downloadable model weights; only the custom subdir migrates.
const VOICE_KEEP_SUBDIR = 'custom';
// Skipped in data/: the DB is snapshotted via the backup API (a raw copy of an open WAL database is
// inconsistent), dojo.sqlite is empty, and the toolbox ledger names this boot's process groups so it
// never travels.
const DATA_FILE_SKIP = new Set(['dojo.db', 'dojo.db-shm', 'dojo.db-wal', 'dojo.sqlite', TOOLBOX_LEDGER_FILE]);
const JUNK = new Set(['.DS_Store']);

function broadcastProgress(stage: string, progress: number, message: string): void {
  broadcast({
    type: 'migration:progress',
    data: { stage, progress, message },
  } as any);
}

// Stream-encrypt a file to payload.enc and return the sha256 of the whole output (salt+iv+ciphertext)
// for the manifest checksum. Streaming is required: readFileSync and crypto.update() cap at 2^31-1
// bytes. Output layout: salt(32) | iv(16) | AES-256-CBC ciphertext.
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

function listFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
}

// The date alone is not unique: a second export the same day would truncate the file a first request
// is still streaming, so the path carries a random suffix (the route shows a clean name).
export function exportOutputPath(date: string): string {
  return path.join(os.tmpdir(), `dojo-export-${date}-${crypto.randomBytes(4).toString('hex')}.zip`);
}

export async function createExport(password: string): Promise<{ filePath: string; manifest: ExportManifest }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-export-'));

  try {
    // Database snapshot using the better-sqlite3 backup API.
    broadcastProgress('database', 10, 'Preparing database snapshot...');
    logger.info('Starting database snapshot');

    const db = getDb();
    const dbBackupPath = path.join(tmpDir, 'data', 'dojo.db');
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });

    await db.backup(dbBackupPath);
    const dbSize = fs.statSync(dbBackupPath).size;
    logger.info('Database snapshot complete', { size: dbSize });

    // Copy ~/.dojo by deny-list so new user folders migrate automatically. Skipped: tools/ (regenerated),
    // logs/, the live DB files in data/ (snapshotted above), the installed app and platform.backup-* dirs.
    broadcastProgress('files', 40, 'Packaging your dojo...');
    copyDojoTree(DOJO_DIR, tmpDir);
    logger.info('Dojo tree copied (deny-list)');

    // Google Workspace auth lives outside ~/.dojo (legacy ~/.config/gws).
    if (fs.existsSync(GWS_DIR)) {
      copyDirRecursive(GWS_DIR, path.join(tmpDir, 'gws'));
    }

    // Cloudflare tunnel setup (~/.cloudflared) is also outside ~/.dojo and needs explicit copying.
    if (fs.existsSync(CLOUDFLARED_DIR)) {
      copyDirRecursive(CLOUDFLARED_DIR, path.join(tmpDir, 'cloudflared'));
      logger.info('Cloudflare tunnel config bundled');
    }

    // Generate the technique-dependency installer (setup-dependencies.sh) from the structured dependency
    // manifests only (injection-safe), so the new machine can install the tools techniques rely on.
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

    broadcastProgress('manifest', 60, 'Generating manifest...');
    const promptFiles = listFiles(path.join(DOJO_DIR, 'prompts'));
    const techniqueNames = listTechniqueNames();
    const uploadsSize = getDirSize(path.join(DOJO_DIR, 'uploads'));
    const manifest = await generateManifest(dbSize, promptFiles, techniqueNames, uploadsSize);

    // Inner archive: everything except the manifest.
    broadcastProgress('archive', 70, 'Creating archive...');
    const innerZipPath = path.join(tmpDir, '_inner.zip');
    await createZipFromDir(tmpDir, innerZipPath, ['_inner.zip']);

    // Stream-encrypt the inner archive and compute its checksum in the same pass.
    broadcastProgress('encrypt', 80, 'Encrypting archive...');
    const payloadEncPath = path.join(tmpDir, 'payload.enc');
    const checksum = await encryptFileToFile(innerZipPath, payloadEncPath, password);
    manifest.checksum = `sha256:${checksum}`;

    // Final zip: unencrypted manifest plus the encrypted payload streamed from disk.
    const date = new Date().toISOString().split('T')[0];
    const outputPath = exportOutputPath(date);
    await createFinalZip(outputPath, manifest, payloadEncPath);

    broadcastProgress('complete', 100, 'Export complete!');
    logger.info('Export complete', { outputPath, size: fs.statSync(outputPath).size });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { filePath: outputPath, manifest };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function copyDirRecursive(src: string, dest: string): void {
  // copyTree is symlink/special-file aware (see fs-copy.ts) and skips JUNK at every level.
  copyTree(src, dest, { skip: JUNK });
}

// Copy only loose, non-.md custom files from ~/.dojo/tools (technique-owned scripts); the .md docs and
// subdirectories regenerate and are skipped.
function copyToolsCustomFiles(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (JUNK.has(entry.name)) continue;
    if (entry.name.toLowerCase().endsWith('.md')) continue;
    fs.mkdirSync(dest, { recursive: true });
    copyTree(path.join(src, entry.name), path.join(dest, entry.name), { skip: JUNK });
  }
}

// Copy ~/.dojo into the export staging dir under the deny-list. The DB snapshot is written to
// <dest>/data/dojo.db first, so the data/ copy only merges the rest.
export function copyDojoTree(srcRoot: string, destRoot: string): void {
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    // tools/ is deny-listed, but a technique may leave custom scripts loose at its root that do not
    // regenerate, so only loose non-.md files migrate.
    if (entry.name === 'tools' && entry.isDirectory()) {
      copyToolsCustomFiles(path.join(srcRoot, 'tools'), path.join(destRoot, 'tools'));
      continue;
    }
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
      copyTree(src, dest, { skip: JUNK });
    }
  }
}

// Like copyDirRecursive but skips the given top-level names (data/ excludes the live DB files).
function copyDirRecursiveExcept(src: string, dest: string, skipTopLevel: Set<string>): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (JUNK.has(name) || skipTopLevel.has(name)) continue;
    copyTree(path.join(src, name), path.join(dest, name), { skip: JUNK });
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

export function createZipFromDir(dirPath: string, outputPath: string, exclude: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    // The output stream can fail independently of the archive (disk full, missing temp folder). With no
    // 'error' listener that is an uncaught exception that takes the server down and the export's cleanup
    // never runs. Reject, stop feeding the dead stream, and settle exactly once so a late 'close' cannot
    // resolve a failed export.
    let settled = false;
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

    output.on('close', () => settle(resolve));
    archive.on('error', reject);
    output.on('error', (err) => {
      try { archive.abort(); } catch { /* the stream is already gone */ }
      settle(() => reject(err));
    });
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

export function createFinalZip(outputPath: string, manifest: ExportManifest, payloadEncPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 1 } }); // light compression, payload already compressed

    // Same output-stream failure handling as createZipFromDir.
    let settled = false;
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };

    output.on('close', () => settle(resolve));
    archive.on('error', reject);
    output.on('error', (err) => {
      try { archive.abort(); } catch { /* the stream is already gone */ }
      settle(() => reject(err));
    });
    archive.pipe(output);

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    archive.file(payloadEncPath, { name: 'payload.enc' });

    archive.finalize();
  });
}
