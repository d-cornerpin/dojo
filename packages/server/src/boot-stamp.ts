// The running process records which code it loaded (pid, version, sha, start time), so a probe reads
// the answer from the process instead of inferring it from an install tree that may have moved since.
// A stamp whose pid is not the listening pid belongs to another process and must be ignored.
// Sha, first hit wins: DOJO_BUILD_SHA, then `build-info.json` from `deploy/build-package.sh` (an install
// has no repository), then one `git rev-parse HEAD` at load when a `.git` exists. Unresolvable is null.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dojoDir } from './home.js';
import { createLogger } from './logger.js';
import { getCurrentVersion } from './gateway/routes/update.js';
import { PROCESS_STARTED_MS } from './process-start.js';

const logger = createLogger('boot-stamp');

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `~/.dojo/server-boot.json`, the one place a probe has to know about. */
export function bootStampPath(): string {
  return dojoDir('server-boot.json');
}

export interface BootStamp {
  readonly pid: number;
  readonly version: string;
  /** Full sha of the code this process LOADED, or null when it cannot be known. */
  readonly sha: string | null;
  readonly shaSource: 'env' | 'package' | 'git' | 'none';
  readonly startedAt: string;
  /** Directory the loaded code was read from: `dist/` on an install, `src/` in dev. */
  readonly moduleDir: string;
  readonly stampVersion: 1;
}

/** Walk up from this module for `build-info.json`, the packaged sha. Never a git call. */
function packagedSha(): string | null {
  let dir = MODULE_DIR;
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'build-info.json');
    try {
      if (fs.existsSync(p)) {
        const info = JSON.parse(fs.readFileSync(p, 'utf-8')) as { sha?: unknown };
        if (typeof info.sha === 'string' && /^[0-9a-f]{7,40}$/.test(info.sha)) return info.sha;
      }
    } catch { /* an unreadable build stamp is a null sha, never a throw at boot */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function devTreeSha(): string | null {
  let dir = MODULE_DIR;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      try {
        const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
        }).trim();
        return /^[0-9a-f]{40}$/.test(out) ? out : null;
      } catch { return null; }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function resolveSha(): { sha: string | null; shaSource: BootStamp['shaSource'] } {
  const env = process.env.DOJO_BUILD_SHA?.trim();
  if (env) return { sha: env, shaSource: 'env' };
  const packaged = packagedSha();
  if (packaged) return { sha: packaged, shaSource: 'package' };
  const dev = devTreeSha();
  if (dev) return { sha: dev, shaSource: 'git' };
  return { sha: null, shaSource: 'none' };
}

/** When the process that wrote the stamp on disk started, in epoch ms: read at start before this process writes its own. */
export function stampedStartMs(): number | null {
  try { const at = Date.parse((JSON.parse(fs.readFileSync(bootStampPath(), 'utf-8')) as BootStamp).startedAt); return Number.isFinite(at) ? at : null; } catch { return null; }
}

/** Write the stamp; never throws, since a box that cannot write it must still boot. */
export function writeBootStamp(): BootStamp | null {
  try {
    const { sha, shaSource } = resolveSha();
    const stamp: BootStamp = {
      pid: process.pid,
      version: getCurrentVersion(),
      sha,
      shaSource,
      startedAt: new Date(PROCESS_STARTED_MS).toISOString(),
      moduleDir: MODULE_DIR,
      stampVersion: 1,
    };
    const target = bootStampPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written whole via a temp file and renamed: a probe must never read a half-written stamp.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(stamp, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, target);
    logger.info('Boot stamp written', {
      pid: stamp.pid, version: stamp.version,
      sha: stamp.sha ? stamp.sha.slice(0, 8) : null, shaSource: stamp.shaSource,
    });
    return stamp;
  } catch (err) {
    logger.warn('Could not write the boot stamp; run provenance will read as unverified', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
