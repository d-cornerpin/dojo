// ════════════════════════════════════════════════════════════════════════════
// THE FILESYSTEM FACADE: the entry that PERFORMS the work the broker decided.
// `agent/brokers/fs.ts` answers *may this agent touch this path?*, this module is
// what touches it: the broker DECIDES, the facade CARRIES, nothing here holds an
// allow list or a rule of its own, every entry asks `requireAuthorized`. The
// shape is deliberately 1:1 with `node:fs`, so a conversion is a rename plus an
// `await`, never a rewrite. Only operations a converted call site uses live
// here: an entry nothing calls is unexercised code pretending to be a lock, and
// categories that convert later bring their own, each with a test that drives it.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeAgentPath, resolveRealPathHardened } from '../path-resolve.js';
import { requireAuthorized, type EffectRequest } from './capability.js';

/** Both spellings of one path, which is what every fs request carries. */
function spellings(target: fs.PathLike): { path: string; real: string } {
  const raw = typeof target === 'string' ? target : String(target);
  return { path: canonicalizeAgentPath(raw), real: resolveRealPathHardened(raw).path };
}

function check(op: Exclude<EffectRequest['op'], 'proc' | 'net'>, target: fs.PathLike): void {
  const { path, real } = spellings(target);
  requireAuthorized({ op, path, real } as EffectRequest);
}

// ── Metadata: authorized by ANY grant naming the path ────────────────────────

export function existsSync(target: fs.PathLike): boolean {
  check('fs_stat', target);
  return fs.existsSync(target);
}

export function statSync(target: fs.PathLike): fs.Stats {
  check('fs_stat', target);
  return fs.statSync(target);
}

export function lstatSync(target: fs.PathLike): fs.Stats {
  check('fs_stat', target);
  return fs.lstatSync(target);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function readFileSync(target: fs.PathLike, encoding: BufferEncoding): string;
export function readFileSync(target: fs.PathLike): Buffer;
export function readFileSync(target: fs.PathLike, encoding?: BufferEncoding): string | Buffer {
  check('fs_read', target);
  return encoding === undefined ? fs.readFileSync(target) : fs.readFileSync(target, encoding);
}

export function readdirSync(target: fs.PathLike, options: { withFileTypes: true }): fs.Dirent[];
export function readdirSync(target: fs.PathLike): string[];
export function readdirSync(
  target: fs.PathLike,
  options?: { withFileTypes: true },
): string[] | fs.Dirent[] {
  check('fs_read', target);
  return options === undefined ? fs.readdirSync(target) : fs.readdirSync(target, options);
}

// ── Writes ──────────────────────────────────────────────────────────────────

export function writeFileSync(
  target: fs.PathLike,
  data: string | NodeJS.ArrayBufferView,
  options?: fs.WriteFileOptions,
): void {
  check('fs_write', target);
  fs.writeFileSync(target, data, options);
}

export function appendFileSync(
  target: fs.PathLike,
  data: string | Uint8Array,
  options?: fs.WriteFileOptions,
): void {
  check('fs_write', target);
  fs.appendFileSync(target, data, options);
}

/** `mkdir -p` under a path this call is authorized to write. */
export function mkdirSync(target: fs.PathLike, options?: fs.MakeDirectoryOptions): void {
  check('fs_mkdir', target);
  fs.mkdirSync(target, options);
}

/** A copy is a read of the source AND a write of the destination: both asked. */
export function copyFileSync(src: fs.PathLike, dest: fs.PathLike): void {
  check('fs_read', src);
  check('fs_write', dest);
  fs.copyFileSync(src, dest);
}

/** A rename removes one name and creates another; both are writes. */
export function renameSync(from: fs.PathLike, to: fs.PathLike): void {
  check('fs_write', from);
  check('fs_write', to);
  fs.renameSync(from, to);
}

// ── Removals ────────────────────────────────────────────────────────────────

export function unlinkSync(target: fs.PathLike): void {
  check('fs_delete', target);
  fs.unlinkSync(target);
}

export function rmSync(target: fs.PathLike, options?: fs.RmOptions): void {
  check('fs_delete', target);
  fs.rmSync(target, options);
}

// WRITE A FILE ATOMICALLY: temp sibling then rename (atomic on one filesystem), so a
// crash never leaves a half file. The error is rethrown unchanged so the caller's own
// message survives; the declared resource is the TARGET, never the temp sibling.
export async function atomicWriteFile(
  target: string,
  data: string,
  encoding: BufferEncoding,
): Promise<void> {
  check('fs_write', target);
  const tmpName = `.${path.basename(target)}.patch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const tmpPath = path.join(path.dirname(target), tmpName);
  try {
    await fs.promises.writeFile(tmpPath, data, encoding);
    await fs.promises.rename(tmpPath, target);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// WRITE THROUGH A `<target>.tmp` SIBLING: the second writer, kept separate from
// `atomicWriteFile` on purpose: blending two mechanisms would change one caller's
// behaviour to match the other's, which a relocation may never do.
export function writeFileViaTmpSiblingSync(
  target: string,
  data: string,
  encoding: BufferEncoding,
): void {
  check('fs_write', target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data, encoding);
  fs.renameSync(tmp, target);
}

// ── The promises surface, same rules ────────────────────────────────────────
// The two overloaded entries are declared as functions because an object literal
// cannot carry overload signatures, and the overloads keep the 1:1 shape.

async function readFileAsync(target: fs.PathLike, encoding: BufferEncoding): Promise<string>;
async function readFileAsync(target: fs.PathLike): Promise<Buffer>;
async function readFileAsync(target: fs.PathLike, encoding?: BufferEncoding): Promise<string | Buffer> {
  check('fs_read', target);
  return encoding === undefined ? fs.promises.readFile(target) : fs.promises.readFile(target, encoding);
}

async function readdirAsync(target: fs.PathLike, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
async function readdirAsync(target: fs.PathLike): Promise<string[]>;
async function readdirAsync(
  target: fs.PathLike,
  options?: { withFileTypes: true },
): Promise<string[] | fs.Dirent[]> {
  check('fs_read', target);
  return options === undefined ? fs.promises.readdir(target) : fs.promises.readdir(target, options);
}

export const promises = {
  async stat(target: fs.PathLike): Promise<fs.Stats> {
    check('fs_stat', target);
    return fs.promises.stat(target);
  },
  readFile: readFileAsync,
  readdir: readdirAsync,
  /** Open a handle: the authorization is on the OPEN, a handle only touches that path. */
  async open(target: fs.PathLike, flags: string): Promise<fs.promises.FileHandle> {
    check(flags.startsWith('r') && !flags.includes('+') ? 'fs_read' : 'fs_write', target);
    return fs.promises.open(target, flags);
  },
  async writeFile(
    target: fs.PathLike,
    data: string | Uint8Array,
    encoding?: BufferEncoding,
  ): Promise<void> {
    check('fs_write', target);
    return fs.promises.writeFile(target, data, encoding);
  },
  async appendFile(
    target: fs.PathLike,
    data: string | Uint8Array,
    encoding?: BufferEncoding,
  ): Promise<void> {
    check('fs_write', target);
    return fs.promises.appendFile(target, data, encoding);
  },
  async mkdir(target: fs.PathLike, options?: fs.MakeDirectoryOptions): Promise<void> {
    check('fs_mkdir', target);
    await fs.promises.mkdir(target, options);
  },
  async rename(from: fs.PathLike, to: fs.PathLike): Promise<void> {
    check('fs_write', from);
    check('fs_write', to);
    return fs.promises.rename(from, to);
  },
  async unlink(target: fs.PathLike): Promise<void> {
    check('fs_delete', target);
    return fs.promises.unlink(target);
  },
};
