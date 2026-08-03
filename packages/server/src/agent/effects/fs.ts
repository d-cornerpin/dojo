// ════════════════════════════════════════════════════════════════════════════
// THE FILESYSTEM FACADE (PHASE-5 T8 Step 2) — the entry that PERFORMS the work.
//
// `agent/brokers/fs.ts` answers *may this agent touch this path?*. This module
// is what touches it. The two are deliberately different files with different
// jobs: **the broker DECIDES, the facade CARRIES**, and nothing here holds an
// allow list, a deny list or a rule of its own — every entry asks
// `requireAuthorized`, which is set membership over resources the gate loop
// already resolved and the brokers already decided about.
//
// ── THE SHAPE IS 1:1 WITH `node:fs`, ON PURPOSE ──
// Every entry takes the same arguments as the `node:fs` call it replaces and
// returns the same value, so a conversion is a rename plus an `await` where the
// original was already async — never a rewrite. Relocation purity is what let
// PHASE-5 catch three would-be capability losses; a facade whose signatures
// "improved" on the ones it replaces would hide the fourth.
//
// ── WHY THE OPERATION SET IS SMALL AND GROWS BY CATEGORY ──
// Only the operations a converted call site actually uses live here. An entry
// nothing calls is unexercised code pretending to be a lock, and this project
// deletes those. Categories that convert later bring their own operations with
// them, each with a test that drives it.
// ════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
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

export function readdirSync(target: fs.PathLike): string[] {
  check('fs_read', target);
  return fs.readdirSync(target);
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

/** A copy is a read of the source AND a write of the destination — both asked. */
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

// ── The promises surface, same rules ────────────────────────────────────────

export const promises = {
  async stat(target: fs.PathLike): Promise<fs.Stats> {
    check('fs_stat', target);
    return fs.promises.stat(target);
  },
  async readFile(target: fs.PathLike, encoding: BufferEncoding): Promise<string> {
    check('fs_read', target);
    return fs.promises.readFile(target, encoding);
  },
  async readdir(target: fs.PathLike): Promise<string[]> {
    check('fs_read', target);
    return fs.promises.readdir(target);
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
