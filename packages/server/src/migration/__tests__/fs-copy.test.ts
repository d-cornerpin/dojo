// ════════════════════════════════════════════════════════════════════════════
// copyTree is symlink- and special-file aware. It exists because the OLD copy
// followed links to their targets (readdir(withFileTypes) reports a directory
// link as not-a-directory, so it fell through to copyFileSync, which macOS then
// rejects with ENOTSUP — the "operation not supported on socket" import crash).
//
// The contract this pins, read straight off src/migration/fs-copy.ts:
//   - a symlink is RECREATED as a symlink, its target kept VERBATIM (never
//     dereferenced) — relative or absolute, and even when the target dangles;
//   - a directory is recursed;
//   - a regular file is copied;
//   - a socket / fifo / device is skipped (copyfile would throw on it), and the
//     skip never crashes the run;
//   - a skip set (default {'.DS_Store'}, or a caller-supplied one that REPLACES
//     the default) names dropped at every level;
//   - an existing dest entry is clobbered so the link/overwrite lands.
//
// Real files, in a throwaway temp tree per test — no mocks: importing ../fs-copy.js
// only pulls in node:fs, node:path and the logger (which resolves its log dir
// through the redirected DOJO_HOME, so it writes into the scratch home, not the
// developer's real ~/.dojo).
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyTree } from '../fs-copy.js';

let root: string;

// One throwaway tree per test; src and dest live under it, and it is torn down
// whole (force handles a left-behind fifo) after the test.
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fscopy-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// mkdir -p the parent so nested files and pre-existing dest files can be written.
function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

describe('copyTree (src/migration/fs-copy.ts)', () => {
  it('walks the whole tree: nested files and an empty directory land intact', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, 'a.txt'), 'A');
    write(path.join(src, 'sub', 'b.txt'), 'B');
    write(path.join(src, 'sub', 'deep', 'c.txt'), 'C');
    fs.mkdirSync(path.join(src, 'empty'));

    copyTree(src, dest);

    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('A');
    expect(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf-8')).toBe('B');
    expect(fs.readFileSync(path.join(dest, 'sub', 'deep', 'c.txt'), 'utf-8')).toBe('C');
    const empty = path.join(dest, 'empty');
    expect(fs.lstatSync(empty).isDirectory()).toBe(true);
    expect(fs.readdirSync(empty)).toEqual([]);
  });

  it('a file symlink is recreated as a symlink, target kept verbatim', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, 'target.txt'), 'the target');
    fs.symlinkSync('target.txt', path.join(src, 'link.txt')); // relative link

    copyTree(src, dest);

    const link = path.join(dest, 'link.txt');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('target.txt');
  });

  it('a directory symlink is recreated as a symlink, never dereferenced into a tree', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, 'real', 'inside.txt'), 'x');
    fs.symlinkSync('real', path.join(src, 'dirlink')); // relative link

    copyTree(src, dest);

    const link = path.join(dest, 'dirlink');
    // lstat is a link, not a directory: the link was copied, not its contents.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('real');
  });

  it('an absolute link target is kept verbatim, even when it dangles', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true }); // symlinkSync does not create its parent
    fs.symlinkSync('/some/absolute/path', path.join(src, 'abs')); // target does not exist

    expect(() => copyTree(src, dest)).not.toThrow();

    const link = path.join(dest, 'abs');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('/some/absolute/path');
  });

  it('a symlink clobbers a pre-existing regular file at the same dest path', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true }); // symlinkSync does not create its parent
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'link.txt'), 'old'); // regular file first
    fs.symlinkSync('target.txt', path.join(src, 'link.txt')); // relative link

    copyTree(src, dest);

    const link = path.join(dest, 'link.txt');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe('target.txt');
  });

  it('an existing dest file is overwritten with the source content', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'a.txt'), 'old');
    write(path.join(src, 'a.txt'), 'new');

    copyTree(src, dest);

    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('new');
  });

  it('skips .DS_Store at every level by default', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, '.DS_Store'), 'junk');
    write(path.join(src, 'sub', '.DS_Store'), 'junk');
    write(path.join(src, 'sub', 'b.txt'), 'B');

    copyTree(src, dest);

    expect(fs.existsSync(path.join(dest, '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'sub', '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'sub', 'b.txt'))).toBe(true);
  });

  it('a caller-supplied skip set REPLACES the default, so .DS_Store is copied', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, '.DS_Store'), 'junk');
    write(path.join(src, 'sub', 'keep.txt'), 'k');

    copyTree(src, dest, { skip: new Set(['sub']) });

    expect(fs.existsSync(path.join(dest, 'sub'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.DS_Store'))).toBe(true);
  });

  it('a fifo (named pipe) is skipped without crashing, and its siblings copy', () => {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    write(path.join(src, 'sibling.txt'), 'ok');
    try {
      execFileSync('mkfifo', [path.join(src, 'pipe')]);
    } catch {
      return; // mkfifo unavailable on this platform — skip this case.
    }

    expect(() => copyTree(src, dest)).not.toThrow();
    expect(fs.existsSync(path.join(dest, 'pipe'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'sibling.txt'))).toBe(true);
  });
});
