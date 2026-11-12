// The disk reads and writes the technique package export and import do. Only share-export.ts and
// share-import.ts import it, both reached only from the dashboard's technique route; no tool dispatch
// reaches it. Paths inside a technique folder go through insideTechniqueDir.

import fs from 'node:fs';
import path from 'node:path';
import type AdmZip from 'adm-zip';
import { createLogger } from '../logger.js';
import { isBinaryFile } from './scrub.js';
import type { DependencyManifest } from './dependencies.js';
import { insideTechniqueDir } from './technique-folder.js';

const logger = createLogger('technique-share-disk');

// Export-side gathering (every text entry returned is scrubbed by share-export)

export interface FileEntry {
  relPath: string;        // path within technique dir, forward slashes
  content?: string;        // text content (text files only)
  absSourcePath: string;   // absolute path on disk (for binary streaming)
  isBinary: boolean;
}

// Every file wanted in the zip. Skips metadata.json (the DB is the source of truth) and versions/
// (snapshots are reconstructable, and would bloat the package and leak old unscrubbed content).
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

// Import-side unpacking

/** One file an import wrote: its path, and the bytes it replaced (null when it did not exist before). */
export interface ExtractedWrite { dest: string; prior: Buffer | null }

/**
 * Put back every file the import overwrote (original bytes) and remove only the files it newly made,
 * newest first. Nothing else is touched: a failed import never damages what it did not create.
 */
export function undoExtraction(journal: ExtractedWrite[]): void {
  for (const w of [...journal].reverse()) {
    try {
      if (w.prior !== null) fs.writeFileSync(w.dest, w.prior);
      else fs.rmSync(w.dest, { force: true });
    } catch (err) {
      logger.warn('Could not undo an imported file', { dest: w.dest, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function extractPackageEntries(zip: AdmZip, dirPath: string, journal: ExtractedWrite[] = []): { extractedCount: number; hasInstructions: boolean } {
  let extractedCount = 0;
  let hasInstructions = false;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryPath = entry.entryName.replace(/^\/+/, '');
    if (!entryPath || entryPath === 'manifest.json') continue;
    const dest = path.resolve(dirPath, entryPath);   // the Mac belongs to the agent: extract where the package says
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // "Already existed" is decided by lstat: a link (even a broken one), a folder or an unreadable file EXISTED,
    // so it is never treated as new and never deleted. Only a missing path or a readable plain file is written.
    let prior: Buffer | null = null;
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dest); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot check "${dest}" before writing it; nothing was imported.`);
    }
    if (st !== null) {
      if (!st.isFile()) throw new Error(`"${dest}" already exists and is not a plain file; nothing was imported.`);
      try { prior = fs.readFileSync(dest); } catch {
        throw new Error(`"${dest}" already exists and cannot be read, so it cannot be safely replaced; nothing was imported.`);
      }
    }
    journal.push({ dest, prior });   // recorded before the write, so a failure mid-write is covered too
    fs.writeFileSync(dest, entry.getData());
    extractedCount++;
    if (entryPath === 'TECHNIQUE.md') hasInstructions = true;
  }
  return { extractedCount, hasInstructions };
}

// Import-side disk work (share-import.ts holds no disk access of its own)

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
