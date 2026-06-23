// ════════════════════════════════════════
// Migration filesystem copy — symlink & special-file aware
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-copy');

// Skipped at every level of the tree (editor/OS cruft).
const DEFAULT_SKIP = new Set(['.DS_Store']);

export interface CopyTreeOptions {
  /** Names skipped at every level (defaults to .DS_Store). */
  skip?: Set<string>;
}

// Recursively copy src → dest, handling every node type a real ~/.dojo can
// contain. Critically, symlinks are RECREATED as symlinks (target preserved
// verbatim), never dereferenced.
//
// This is the fix for the import crash:
//   ENOTSUP: operation not supported on socket, copyfile
//   '.../platform/node_modules/@dojo/dashboard' -> '.../@dojo/dashboard'
// An installed platform's node_modules holds npm-workspace symlinks
// (@dojo/dashboard -> ../../packages/dashboard, plus .bin/* link scripts). The
// old recursive copy used readdirSync(withFileTypes) where a symlink reports
// isDirectory() === false, so it fell through to fs.copyFileSync(), which
// follows the link to a directory; macOS copyfile() then fails with ENOTSUP
// (surfaced as the misleading "operation not supported on socket"). Preserving
// the link verbatim copies it instantly and keeps it valid, because the copy
// brings the link's target along too (the whole platform/ tree is copied).
//
//   - symlink       → recreated as a symlink (relative or absolute target kept)
//   - directory     → created, recursed
//   - regular file  → copied
//   - socket / fifo / device → skipped (not migratable; copyfile() errors on them)
export function copyTree(src: string, dest: string, opts: CopyTreeOptions = {}): void {
  copyEntry(src, dest, opts.skip ?? DEFAULT_SKIP);
}

function copyEntry(src: string, dest: string, skip: Set<string>): void {
  // lstat, not stat: we must see the symlink itself, not its target.
  const st = fs.lstatSync(src);

  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    // Clear any pre-existing dest so symlinkSync doesn't EEXIST.
    try { fs.rmSync(dest, { force: true, recursive: true }); } catch { /* nothing there */ }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(target, dest);
    return;
  }

  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (skip.has(name)) continue;
      copyEntry(path.join(src, name), path.join(dest, name), skip);
    }
    return;
  }

  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return;
  }

  // Socket, FIFO, char/block device: nothing a dojo needs, and copyfile() would
  // throw on it. Skip and note it (rare, but possible inside node_modules).
  logger.warn('Skipping non-regular file during migration copy', { src });
}
