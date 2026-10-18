// ════════════════════════════════════════════════════════════════════════════════════════
// THE ONE WAY A PLATFORM TREE BECOMES LIVE (t197, v3.4 F2; owner ruling 2026-08-30: an
// update never fails, and never leaves a box half-updated).
//
// The new tree is built and checked BESIDE the live one, then switched in by two renames:
//   live -> platform.backup-<old>, then staged -> live.
// Until the first rename the box is wholly old; after the second it is wholly new. The only
// gap is the instant between them, when `~/.dojo/platform` does not exist. The swap is
// recorded first (`markPendingUpdate` with the staged path), so the repairs can finish it:
// `rollback.sh --heal` (run by the watchdog when the folder is missing) and the boot sentinel
// (`settlePendingInstall`, which names what is actually live). The old tree IS the backup, so
// the whole-tree `cp -R` copy is gone too.
//
// Every caller uses this: the in-app update, the rollback route and `deploy/install.sh` (via
// `install-tree-cli.ts`, from the unpacked release: so Node built-ins only, no node_modules).
// ════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import { markPendingUpdate, updateMarker, type UpdatePhase } from '../update-state.js';
import { attachIdleBound } from '../child-idle-bound.js';
import { isOutOfSpaceError, outOfSpaceFailureMessage } from './disk-preflight.js';
import { childFailureText } from './child-failure.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('install-tree');

/** Work dirs are `platform.staging-<installer pid>-<ms>`: a dead pid means an orphan. */
export const STAGING_PREFIX = 'platform.staging-';
/** THE lock for anything that moves `~/.dojo/platform` (rollback.sh's, by name); holds a pid. */
export const SWAP_LOCK = 'rollback.lock';

export type InstallStep = 'deps-cloned' | 'deps-installed' | 'verified' | 'marked' | 'aside' | 'swapped';

/** t114: npm is bounded by SILENCE, not a flat total, so a slow but moving install finishes. */
const INSTALL_IDLE_MS = 120_000;
const INSTALL_CEILING_MS = 30 * 60_000;
const DEFAULT_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` });

export async function runNpmInstall(cwd: string, env: NodeJS.ProcessEnv = DEFAULT_ENV()): Promise<void> {
  const child = spawn('/bin/sh', ['-c', 'npm install --omit=dev'], { cwd, env });
  await attachIdleBound(child, { idleMs: INSTALL_IDLE_MS, ceilingMs: INSTALL_CEILING_MS });
}

export function newInstallWorkDir(dojoDir: string): string {
  const dir = path.join(dojoDir, `${STAGING_PREFIX}${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** install.sh's staging: a COPY (the package sits on another volume; the swap needs this one). */
export function stagePackageCopy(source: string, dojoDir: string): { work: string; staged: string } {
  const work = newInstallWorkDir(dojoDir);
  fs.cpSync(source, path.join(work, 'platform'), { recursive: true, verbatimSymlinks: true });
  return { work, staged: path.join(work, 'platform') };
}

export function discardWorkDir(work: string): void { fs.rmSync(work, { recursive: true, force: true }); }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Work dirs whose installer process is gone. Never one a running installer still owns. */
export function deadInstallWorkDirs(dojoDir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dojoDir); } catch { return []; }
  return names.filter((n) => {
    if (!n.startsWith(STAGING_PREFIX)) return false;
    const pid = Number(n.slice(STAGING_PREFIX.length).split('-')[0]);
    return !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
  }).map((n) => path.join(dojoDir, n));
}

/** The swap lock, or the reason it is busy. A holder whose pid is dead is no holder. */
export function acquireSwapLock(dojoDir: string): (() => void) | { busy: string } {
  const lock = path.join(dojoDir, SWAP_LOCK);
  const pidFile = path.join(lock, 'pid');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(pidFile, String(process.pid));
      return () => {
        try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { busy: `the install lock could not be taken (${(err as Error).message})` };
      let holder: number | null = null;
      try { holder = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { /* no pid yet */ }
      if (holder !== null && pidAlive(holder)) return { busy: `another install or restore is already running (process ${holder})` };
      // No pid at all: the holder writes it the instant after mkdir, so a pid-less lock is
      // either being taken right now or was left by a script that predates the pid file.
      if (holder === null && Date.now() - fs.statSync(lock).mtimeMs < 60_000) return { busy: 'another install or restore is just starting' };
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  return { busy: 'the install lock could not be taken' };
}

export function treeVersion(dir: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v !== '' ? v : null;
  } catch { return null; }
}

/** Copy-on-write clone on APFS (free); a plain copy where the volume cannot clone. */
async function cloneTree(src: string, dst: string): Promise<void> {
  try { await execFileAsync('cp', ['-Rc', src, dst]); } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    await execFileAsync('cp', ['-R', src, dst]);
  }
}

// Loads the database module the server cannot run without, from the STAGED tree, in a
// separate node — the check a staged tree with a missing or wrong-ABI binding fails.
const NATIVE_SMOKE = "const r=require('module').createRequire(process.argv[1]+'/');"
  + "const D=r('better-sqlite3');const d=new D(':memory:');d.prepare('select 1').get();d.close();";

/** Why the staged tree must not go live, or null when it may. */
export async function verifyStagedTree(dir: string, targetVersion: string): Promise<string | null> {
  const v = treeVersion(dir);
  if (v !== targetVersion) return `it says it is version ${v ?? 'unknown'}, not ${targetVersion}`;
  if (!fs.existsSync(path.join(dir, 'packages', 'server', 'dist', 'index.js'))) return 'its server program is missing';
  try {
    await execFileAsync(process.execPath, ['-e', NATIVE_SMOKE, path.join(dir, 'packages', 'server')], { timeout: 60_000 });
  } catch (err) {
    return `its database module will not load (${(err as { stderr?: string }).stderr?.trim().split('\n').pop() ?? (err as Error).message})`;
  }
  return null;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Settle a 'pending-update' its installer did not live to finish. Two renames leave the live tree
 * wholly one side: the target with the staged tree consumed (boot it as the new build) or not
 * (nothing switched; the watchdog tells the owner). Staging-installer markers only: an in-place
 * updater's tree may be mixed, and this cannot tell which half it is. Called at boot right before
 * the boot sentinel counts the boot, and by the installer when its own swap fails.
 */
export function settlePendingInstall(dojoDir: string): UpdatePhase | null {
  const live = treeVersion(path.join(dojoDir, 'platform'));
  let settled: UpdatePhase | null = null;
  updateMarker((m) => {
    if (!m || m.phase !== 'pending-update' || !m.stagingDir) return null;
    settled = live === m.targetVersion && !fs.existsSync(m.stagingDir) ? 'booting-new' : 'interrupted';
    return { ...m, phase: settled, bootAttempts: 0, firstBootAt: null, lastBootAt: null, confirmedHealthyAt: null };
  });
  return settled;
}

export interface InstallTreeArgs {
  /** `~/.dojo`. The staged tree must be on this volume: the swap is a rename. */
  dojoDir: string;
  /** A complete platform tree; its node_modules may be absent (cloned from live here). */
  stagedDir: string;
  targetVersion: string;
  /** The version being replaced, for the record. Read from the live tree when null. */
  previousVersion: string | null;
  runInstall: (cwd: string) => Promise<unknown>;
  /** Progress, and the seam the fault-injection suite kills the process at. */
  onStep?: (step: InstallStep) => void;
}

export type InstallTreeResult = { ok: true; backupDir: string | null } | { ok: false; message: string };

export async function installPlatformTree(a: InstallTreeArgs): Promise<InstallTreeResult> {
  const platformDir = path.join(a.dojoDir, 'platform');
  const live = treeVersion(platformDir);
  const kept = `Nothing was changed: Dojo is still running ${live ?? 'the version it had'}.`;
  const step = (s: InstallStep): void => { logger.info('install step', { step: s, target: a.targetVersion }); a.onStep?.(s); };
  const fail = (message: string): InstallTreeResult => {
    fs.rmSync(a.stagedDir, { recursive: true, force: true });
    logger.warn('install refused before the swap; the live tree is untouched', { message });
    return { ok: false, message };
  };

  const release = acquireSwapLock(a.dojoDir);
  if (typeof release !== 'function') return fail(`The update could not start: ${release.busy}. ${kept}`);
  let marked = false;
  try {
    // ── 1. PREPARE, beside the live tree. Nothing here touches it. ──
    try {
      const liveModules = path.join(platformDir, 'node_modules');
      const stagedModules = path.join(a.stagedDir, 'node_modules');
      if (fs.existsSync(liveModules) && !fs.existsSync(stagedModules)) await cloneTree(liveModules, stagedModules);
      step('deps-cloned');
      await a.runInstall(a.stagedDir);
      step('deps-installed');
    } catch (err) {
      const why = childFailureText(err);
      if (isOutOfSpaceError(err)) return fail(`${outOfSpaceFailureMessage(why.slice(0, 300))} ${kept}`);
      return fail(`The update could not finish preparing ${a.targetVersion}: its add-ons did not install (${why.slice(0, 300)}). ${kept} Check the internet connection and run the update again.`);
    }
    const bad = await verifyStagedTree(a.stagedDir, a.targetVersion);
    if (bad) return fail(`The downloaded ${a.targetVersion} did not pass its safety check (${bad}), so it was not installed. ${kept}`);
    step('verified');

    // ── 2. SWAP. Recorded first, so a crash between the renames can be finished. ──
    const liveExists = fs.existsSync(platformDir);
    const aside = live ? path.join(a.dojoDir, `platform.backup-${live}`)
      : path.join(a.dojoDir, `platform.failed-unknown-${stamp()}`);
    if (liveExists && fs.existsSync(aside)) await execFileAsync('rm', ['-rf', aside]);
    if (live) {
      markPendingUpdate({ targetVersion: a.targetVersion, previousVersion: a.previousVersion ?? live, backupDir: aside, stagingDir: a.stagedDir });
      marked = true;
    }
    step('marked');
    if (liveExists) fs.renameSync(platformDir, aside);
    step('aside');
    try {
      fs.renameSync(a.stagedDir, platformDir);
    } catch (err) {
      // The watchdog's repair may have finished this very swap first; that is success.
      if (treeVersion(platformDir) !== a.targetVersion) throw err;
    }
    step('swapped');
    return { ok: true, backupDir: live ? aside : null };
  } catch (err) {
    // Only a rename can land here. Put the old tree back if the folder is missing, and let
    // the record say truthfully what is live.
    const platformMissing = !fs.existsSync(path.join(platformDir, 'package.json'));
    const aside = live ? path.join(a.dojoDir, `platform.backup-${live}`) : null;
    if (platformMissing && aside && fs.existsSync(aside)) {
      try { fs.rmSync(platformDir, { recursive: true, force: true }); fs.renameSync(aside, platformDir); } catch { /* the watchdog repairs it */ }
    }
    if (marked) settlePendingInstall(a.dojoDir);
    logger.error('install failed during the swap', { error: (err as Error).message });
    return fail(`The update to ${a.targetVersion} stopped while switching versions (${(err as Error).message}). `
      + `Dojo is now running ${treeVersion(platformDir) ?? 'no version'}; if it does not come back on its own, run ~/.dojo/scripts/rollback.sh.`);
  } finally {
    release();
  }
}
