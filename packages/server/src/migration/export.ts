// ════════════════════════════════════════
// Migration Export — database snapshot, file collection, encryption, zip
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { getDb, getDbPath } from '../db/connection.js';
import { generateManifest, type ExportManifest } from './manifest.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-export');

const DOJO_DIR = path.join(os.homedir(), '.dojo');
const GWS_DIR = path.join(os.homedir(), '.config', 'gws');

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

function encryptBuffer(data: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  // Prepend salt (32) + IV (16) so decryption knows what to use
  return Buffer.concat([salt, iv, encrypted]);
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

    // Step 1b: Copy large file cache (memory system)
    const filesDir = path.join(DOJO_DIR, 'data', 'files');
    if (fs.existsSync(filesDir)) {
      copyDirRecursive(filesDir, path.join(tmpDir, 'data', 'files'));
      logger.info('Large file cache copied');
    }

    // Step 2: Copy prompts
    broadcastProgress('prompts', 25, 'Packaging prompts and techniques...');
    const promptsDir = path.join(DOJO_DIR, 'prompts');
    const promptFiles = listFiles(promptsDir);
    if (promptFiles.length > 0) {
      const destPrompts = path.join(tmpDir, 'prompts');
      fs.mkdirSync(destPrompts, { recursive: true });
      for (const file of promptFiles) {
        fs.copyFileSync(path.join(promptsDir, file), path.join(destPrompts, file));
      }
    }

    // Step 3: Copy techniques (recursive)
    const techniquesDir = path.join(DOJO_DIR, 'techniques');
    const techniqueNames: string[] = [];
    if (fs.existsSync(techniquesDir)) {
      const destTech = path.join(tmpDir, 'techniques');
      copyDirRecursive(techniquesDir, destTech);
      techniqueNames.push(...fs.readdirSync(techniquesDir).filter(f => {
        return fs.statSync(path.join(techniquesDir, f)).isDirectory();
      }));
    }

    // Step 4: Copy uploads
    broadcastProgress('uploads', 40, 'Packaging uploads...');
    const uploadsDir = path.join(DOJO_DIR, 'uploads');
    const uploadsSize = getDirSize(uploadsDir);
    if (fs.existsSync(uploadsDir) && uploadsSize > 0) {
      copyDirRecursive(uploadsDir, path.join(tmpDir, 'uploads'));
    }

    // Step 5: Copy secrets.yaml
    broadcastProgress('secrets', 50, 'Securing secrets...');
    const secretsPath = path.join(DOJO_DIR, 'secrets.yaml');
    if (fs.existsSync(secretsPath)) {
      fs.copyFileSync(secretsPath, path.join(tmpDir, 'secrets.yaml'));
    }

    // Step 6: Copy config directory
    const configDir = path.join(DOJO_DIR, 'config');
    if (fs.existsSync(configDir)) {
      copyDirRecursive(configDir, path.join(tmpDir, 'config'));
    }

    // Step 7: Copy Google Workspace auth (if exists)
    if (fs.existsSync(GWS_DIR)) {
      copyDirRecursive(GWS_DIR, path.join(tmpDir, 'gws'));
    }

    // Step 8: Generate manifest
    broadcastProgress('manifest', 60, 'Generating manifest...');
    const manifest = generateManifest(dbSize, promptFiles, techniqueNames, uploadsSize);

    // Step 9: Create inner archive (everything except manifest)
    broadcastProgress('archive', 70, 'Creating archive...');
    const innerZipPath = path.join(tmpDir, '_inner.zip');
    await createZipFromDir(tmpDir, innerZipPath, ['_inner.zip']);

    // Step 10: Encrypt the inner archive
    broadcastProgress('encrypt', 80, 'Encrypting archive...');
    const innerData = fs.readFileSync(innerZipPath);
    const encrypted = encryptBuffer(innerData, password);

    // Step 11: Calculate checksum of encrypted data
    broadcastProgress('checksum', 90, 'Generating checksum...');
    const checksum = crypto.createHash('sha256').update(encrypted).digest('hex');
    manifest.checksum = `sha256:${checksum}`;

    // Step 12: Create final zip with manifest (unencrypted) + encrypted payload
    const date = new Date().toISOString().split('T')[0];
    const outputPath = path.join(os.tmpdir(), `dojo-export-${date}.zip`);
    await createFinalZip(outputPath, manifest, encrypted);

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
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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

function createFinalZip(outputPath: string, manifest: ExportManifest, encryptedPayload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 1 } }); // light compression, payload already compressed

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Manifest is unencrypted and first in the zip
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Encrypted payload
    archive.append(encryptedPayload, { name: 'payload.enc' });

    archive.finalize();
  });
}
