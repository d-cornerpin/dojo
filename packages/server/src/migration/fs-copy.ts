// Migration filesystem copy: aware of symlinks and special files.

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const logger = createLogger('migration-copy');

const DEFAULT_SKIP = new Set(['.DS_Store']);

export interface CopyTreeOptions {
  skip?: Set<string>;
}

// Recursively copy src to dest. Symlinks are recreated verbatim, never dereferenced: copying through a
// link to a directory fails with ENOTSUP in macOS copyfile(), and the link stays valid because the whole
// tree is copied with it. Sockets, FIFOs and devices are skipped (not migratable).
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

  logger.warn('Skipping non-regular file during migration copy', { src });
}
