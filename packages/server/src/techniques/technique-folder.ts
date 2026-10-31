// ════════════════════════════════════════
// THE TECHNIQUE FOLDER'S DISK DOOR — the one "resolve inside this folder" check, and the disk work the
// technique share import and export do with it (one module, so the whole folder rule lives in one place).
//
// Requirement: a path that comes from outside the platform (an agent's supporting-file name, a
// package's technique id, an entry found while walking a folder) may only ever land strictly inside
// the folder it is meant for. Absolute paths, dot segments and links that point out are refused.
// A pure leaf (node:fs and node:path only) so any module can import it.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import type AdmZip from 'adm-zip';
import { createLogger } from '../logger.js';
import { isBinaryFile } from './scrub.js';
import type { DependencyManifest } from './dependencies.js';

const logger = createLogger('technique-folder');

/** The shape the store gives every technique id (`createTechnique` slugs names to this). */
export function isSafeTechniqueId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 200;
}

/**
 * The real path of the nearest part of `p` that exists (so a link anywhere along it is followed),
 * or null when an entry exists but cannot be resolved (a broken link or a link loop): a write
 * through it could land anywhere, so the caller must treat it as outside.
 */
function realOfNearestExisting(p: string): string | null {
  let cur = p;
  for (;;) {
    try { return fs.realpathSync(cur); } catch { /* not resolvable: missing, or a dead link */ }
    try { fs.lstatSync(cur); return null; } catch { /* truly not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * The full path of `rel` inside `dirPath`, or null when `rel` is empty, not a string, absolute,
 * resolves to the folder itself or outside it, or passes through a link that leads outside.
 */
export function insideTechniqueDir(dirPath: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const root = path.resolve(dirPath);
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep)) return null;
  const realRoot = realOfNearestExisting(root);
  const realTarget = realOfNearestExisting(resolved);
  if (realRoot === null || realTarget === null) return null;
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return resolved;
}

/**
 * Every supporting-file name resolved inside `dirPath`: a Map of name to full path, or the plain
 * refusal for the first name that does not stay inside (callers write nothing in that case).
 */
export function supportingFileTargets(dirPath: string, files: Array<{ path: string }> | undefined): Map<string, string> | string {
  const targets = new Map<string, string>();
  for (const file of files ?? []) {
    const target = insideTechniqueDir(dirPath, file.path);
    if (target === null) return `Supporting file path "${file.path}" must stay inside the technique folder.`;
    targets.set(file.path, target);
  }
  return targets;
}

// ── Export-side gathering (every text entry returned is scrubbed by share-export) ──

export interface FileEntry {
  relPath: string;        // path within technique dir, forward slashes
  content?: string;        // text content (text files only)
  absSourcePath: string;   // absolute path on disk (for binary streaming)
  isBinary: boolean;
}

/**
 * Walk the technique directory and return every file we want in the
 * zip. Skips metadata.json (DB is the source of truth), and skips the
 * versions/ folder (snapshots are reconstructable from the latest
 * TECHNIQUE.md + version history — including them would bloat the
 * package and leak old un-scrubbed content).
 */
export function collectTechniqueFiles(dirPath: string): { entries: FileEntry[]; skippedLinks: string[] } {
  const entries: FileEntry[] = [];
  const skippedLinks: string[] = [];

  function walk(absDir: string, relPrefix: string): void {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.name === 'metadata.json') continue;
      if (entry.name === 'versions') continue;
      if (entry.name === 'IMPORT_MANIFEST.json') continue; // only present on imported techniques

      // A link is never followed: it could point at a file anywhere on the box. It is skipped and
      // reported, and a path that does not resolve inside the technique folder is treated the same.
      if (entry.isSymbolicLink() || insideTechniqueDir(dirPath, relPath) === null) {
        skippedLinks.push(relPath);
        continue;
      }

      if (entry.isDirectory()) {
        walk(absPath, relPath);
        continue;
      }

      if (isBinaryFile(relPath)) {
        entries.push({ relPath, absSourcePath: absPath, isBinary: true });
        continue;
      }
      try {
        entries.push({ relPath, absSourcePath: absPath, isBinary: false, content: fs.readFileSync(absPath, 'utf-8') });
      } catch (err) {
        logger.warn('Failed to read technique file for export', { absPath, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  walk(dirPath, '');
  return { entries, skippedLinks };
}

/**
 * The walked files with the patched dependencies.json (replacing the on-disk one, which is
 * untouched) and the auto-bundled files added, text ones read so the scrubber sees them.
 */
export function withBundledEntries(
  walked: FileEntry[],
  dirPath: string,
  workingManifest: DependencyManifest,
  extraBundledFiles: Array<{ relPath: string; absSourcePath: string }>,
): FileEntry[] {
  const replaced = new Set<string>(['dependencies.json', ...extraBundledFiles.map(f => f.relPath)]);
  const entries = walked.filter(e => !replaced.has(e.relPath));
  entries.push({
    relPath: 'dependencies.json',
    absSourcePath: path.join(dirPath, 'dependencies.json'),
    isBinary: false,
    content: JSON.stringify(workingManifest, null, 2) + '\n',
  });
  for (const f of extraBundledFiles) {
    if (isBinaryFile(f.relPath)) {
      entries.push({ relPath: f.relPath, absSourcePath: f.absSourcePath, isBinary: true });
      continue;
    }
    try {
      entries.push({ relPath: f.relPath, absSourcePath: f.absSourcePath, isBinary: false, content: fs.readFileSync(f.absSourcePath, 'utf-8') });
    } catch (err) {
      logger.warn('Failed to read bundled file for export', { relPath: f.relPath, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return entries;
}

/** README sections for what the scrubber could not cover: binary files, and links left out. */
export function packageNotes(entries: FileEntry[], skippedLinks: string[]): string {
  const list = (paths: string[]) => paths.map(p => `- \`${p}\``).join('\n');
  const binaryPaths = entries.filter(e => e.isBinary).map(e => e.relPath);
  let notes = '';
  if (binaryPaths.length > 0) {
    notes += `\n\n## Binary files (not scrubbed)\n\nThese files are included exactly as they are and could not be checked for secrets:\n\n${list(binaryPaths)}\n`;
  }
  if (skippedLinks.length > 0) {
    notes += `\n\n## Links left out\n\nThese links in the technique folder were not followed and are not in the package:\n\n${list(skippedLinks)}\n`;
  }
  return notes;
}

// ── Import-side unpacking ──

export function extractPackageEntries(zip: AdmZip, dirPath: string): { extractedCount: number; hasInstructions: boolean } {
  let extractedCount = 0;
  let hasInstructions = false;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryPath = entry.entryName.replace(/^\/+/, '');
    if (!entryPath || entryPath === 'manifest.json') continue;
    const dest = insideTechniqueDir(dirPath, entryPath);
    if (dest === null) {
      logger.warn('Zip entry escapes target dir, skipping', { entryPath });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    extractedCount++;
    if (entryPath === 'TECHNIQUE.md') hasInstructions = true;
  }
  return { extractedCount, hasInstructions };
}

// ── Import-side disk work (share-import.ts holds no disk access of its own) ──

/** Make `dirPath` (and any parents) if it is missing. */
export function ensureFolder(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Make a NEW folder; refuses when it already exists. */
export function makeNewFolder(dirPath: string): void {
  if (fs.existsSync(dirPath)) throw new Error(`Target directory ${dirPath} already exists.`);
  fs.mkdirSync(dirPath, { recursive: true });
}

export function removeFolder(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/** Write one text file at a fixed name directly inside the folder. */
export function writeFolderText(dirPath: string, name: string, text: string): void {
  fs.writeFileSync(path.join(dirPath, name), text, 'utf-8');
}

/** Read one text file at a fixed name directly inside the folder, or null when it is not there. */
export function readFolderText(dirPath: string, name: string): string | null {
  const file = path.join(dirPath, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}
