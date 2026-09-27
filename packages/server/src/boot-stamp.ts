// ── WHAT CODE IS THIS PROCESS RUNNING? (release-blocker round) ────────────────────────────
//
// ── THE DEFECT, AND IT COST THREE INCIDENTS THIS CYCLE ──
// The kit's `serverIdentity()` answered "which code is the server running?" by finding the
// listening pid, reading its `cwd`, and running `git -C <cwd> rev-parse HEAD`. That attests THE
// INSTALL DIRECTORY AT PROBE TIME, which is a different fact from the one everybody read it as.
// A dev server started an hour ago, on a tree that has since moved four commits, reports the
// NEW sha while executing the OLD code — and every record written from that probe names a
// commit the run never tested. That is the same class as run `bms2ldriox4`, which
// `assertServerTreeMatches` was written for, except the mismatch is in TIME rather than in
// PLACE, so a tree check cannot see it.
//
// ── THE FIX: THE PROCESS SAYS SO ITSELF, ONCE, AT BOOT ──
// Whoever loaded the code is the only authority on which code was loaded. At boot the server
// writes a stamp naming its own pid, version, sha and start time, and the probe reads it back —
// so the answer is produced BY the running process rather than inferred ABOUT it. A stamp whose
// `pid` is not the listening pid is somebody else's and must be ignored, which is what makes a
// leftover file harmless.
//
// ── WHERE THE SHA COMES FROM, AND WHY NOT `git` ──
// In order, first hit wins:
//   1. `DOJO_BUILD_SHA` — an explicit override, for a box that knows better than we do.
//   2. `build-info.json` beside the platform manifest — written by `deploy/build-package.sh` at
//      PACKAGE time. This is the production answer: a user's box has no repository, so a git
//      call there would be wrong (and usually fail), and the packaged bytes already know which
//      commit produced them.
//   3. A SINGLE `git rev-parse HEAD`, and ONLY when a `.git` directory is actually present next
//      to the module. That is the dev-tree answer. It is a git call, but it is not the defect:
//      the defect was calling git at PROBE time against a tree that had moved on. Calling it
//      once, in-process, at load, records the sha the loaded code was built from and can never
//      drift afterwards. On a packaged install step 2 wins and this never runs.
// A sha that cannot be resolved is `null`, never a guess — the probe refuses on null rather
// than recording a fiction.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dojoDir } from './home.js';
import { createLogger } from './logger.js';
import { getCurrentVersion } from './gateway/routes/update.js';

const logger = createLogger('boot-stamp');

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `~/.dojo/server-boot.json` — the one place a probe has to know about. */
export function bootStampPath(): string {
  return dojoDir('server-boot.json');
}

export interface BootStamp {
  /** The process that wrote this. A stamp whose pid is not the listening pid is not about it. */
  readonly pid: number;
  /** Platform version, from the tree's ONE version authority. */
  readonly version: string;
  /** Full commit sha of the code this process LOADED, or null when it cannot be known. */
  readonly sha: string | null;
  /** Where the sha came from, so a reader can weigh it: env | package | git | none. */
  readonly shaSource: 'env' | 'package' | 'git' | 'none';
  /** ISO instant this process started serving. */
  readonly startedAt: string;
  /** The directory the loaded code was read from — `dist/` on an install, `src/` in dev. */
  readonly moduleDir: string;
  /** Stamp format, so a probe can refuse a shape it does not understand. */
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

/**
 * One `git rev-parse HEAD`, and only in a real checkout. `execFileSync` with an argv array
 * rather than a shell string: no interpolation, nothing to quote.
 */
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

function resolveSha(): { sha: string | null; shaSource: BootStamp['shaSource'] } {
  const env = process.env.DOJO_BUILD_SHA?.trim();
  if (env) return { sha: env, shaSource: 'env' };
  const packaged = packagedSha();
  if (packaged) return { sha: packaged, shaSource: 'package' };
  const dev = devTreeSha();
  if (dev) return { sha: dev, shaSource: 'git' };
  return { sha: null, shaSource: 'none' };
}

/**
 * Write the stamp. Called once, at boot, from `gateway/server.ts`.
 *
 * NEVER THROWS. A box that cannot write this file must still boot — the stamp is an assertion
 * about the process, not a precondition for it. A failure is logged at WARN and the probe then
 * reports "unverified", which is the honest outcome and exactly what it reported before this
 * existed.
 */
export function writeBootStamp(): BootStamp | null {
  try {
    const { sha, shaSource } = resolveSha();
    const stamp: BootStamp = {
      pid: process.pid,
      version: getCurrentVersion(),
      sha,
      shaSource,
      startedAt: new Date().toISOString(),
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
