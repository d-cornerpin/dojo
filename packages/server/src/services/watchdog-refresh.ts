// Watchdog self-refresh: installs the watchdog bundled in the platform package (platform/watchdog-dist) over
// ~/.dojo/watchdog and kickstarts it, since the in-app updater rewrites only ~/.dojo/platform. Called from
// index.ts before runMigrations (so the new watchdog supervises the first-boot migrations) and from the updater.
// Best-effort, never throws; no-op off darwin or without a bundle.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { compareVersions } from '../gateway/routes/update.js';
import { homeDir } from '../home.js';

const execAsync = promisify(exec);
const logger = createLogger('watchdog-refresh');

const DOJO_DIR = path.join(homeDir(), '.dojo');
const PLATFORM_DIR = path.join(DOJO_DIR, 'platform');
const BUNDLE_DIR = path.join(PLATFORM_DIR, 'watchdog-dist');
const INSTALLED_DIR = path.join(DOJO_DIR, 'watchdog');
const VERSION_FILE = 'watchdog.version';
const WATCHDOG_LABEL = 'com.dojo.watchdog';

interface WatchdogVersion { version: string; hash: string; raw: string; }

function readVersionFile(dir: string): WatchdogVersion | null {
  try {
    const raw = fs.readFileSync(path.join(dir, VERSION_FILE), 'utf-8').trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/);
    return { version: parts[0] ?? '0.0.0', hash: parts[1] ?? '', raw };
  } catch {
    return null;
  }
}

// Refresh when nothing is installed, the bundle is newer, or the version matches but the hash differs.
function shouldRefresh(bundle: WatchdogVersion, installed: WatchdogVersion | null): boolean {
  if (!installed) return true;
  const cmp = compareVersions(bundle.version, installed.version);
  if (cmp > 0) return true;
  if (cmp === 0 && bundle.hash !== '' && bundle.hash !== installed.hash) return true;
  return false;
}

/** Whole-copy dist swap (`dist.next` then renames): a crash leaving no `dist` is healed next boot. Never throws. */
export function healWatchdogDistSwap(installedDir: string): 'none' | 'restored-next' | 'restored-previous' {
  const dist = path.join(installedDir, 'dist');
  if (fs.existsSync(dist)) return 'none';
  for (const [side, outcome] of [['dist.next', 'restored-next'], ['dist.previous', 'restored-previous']] as const) {
    try { fs.renameSync(path.join(installedDir, side), dist); logger.warn('Watchdog code folder was missing; put a whole copy back', { from: side }); return outcome; } catch { /* try the other side */ }
  }
  return 'none';
}

export interface WatchdogRefreshResult {
  refreshed: boolean;
  reason: string;
}

/** Install the bundled watchdog over ~/.dojo/watchdog and kickstart it; `force` skips the version comparison. */
export async function refreshBundledWatchdog(opts: { force?: boolean } = {}): Promise<WatchdogRefreshResult> {
  try {
    if (process.platform !== 'darwin') return { refreshed: false, reason: 'not-darwin' };
    // install.sh creates the installed dir; its absence means a dev checkout, so nothing to refresh.
    if (!fs.existsSync(INSTALLED_DIR)) return { refreshed: false, reason: 'no-installed-watchdog' };
    healWatchdogDistSwap(INSTALLED_DIR);
    if (!fs.existsSync(path.join(BUNDLE_DIR, 'dist'))) return { refreshed: false, reason: 'no-bundle' };

    const bundle = readVersionFile(BUNDLE_DIR);
    if (!bundle) return { refreshed: false, reason: 'bundle-missing-version' };
    const installed = readVersionFile(INSTALLED_DIR);

    if (!opts.force && !shouldRefresh(bundle, installed)) {
      return { refreshed: false, reason: 'up-to-date' };
    }

    logger.info('Refreshing installed watchdog from platform bundle', {
      bundleVersion: bundle.version,
      installedVersion: installed?.version ?? null,
      force: !!opts.force,
    });

    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` };

    // Switch the built code in whole (see healWatchdogDistSwap), preserving node_modules: install.sh built the
    // native module there and the bundle ships none. The version marker is written last, so a cut-off refresh retries.
    const dist = path.join(INSTALLED_DIR, 'dist');
    await execAsync(`rm -rf "${dist}.next" "${dist}.previous" && cp -R "${path.join(BUNDLE_DIR, 'dist')}" "${dist}.next"`, { timeout: 30000, env });
    // package.json says "type": "module"; a truncated one makes node misread every file, so swap a whole copy.
    fs.copyFileSync(path.join(BUNDLE_DIR, 'package.json'), path.join(INSTALLED_DIR, 'package.json.next'));
    fs.renameSync(path.join(INSTALLED_DIR, 'package.json.next'), path.join(INSTALLED_DIR, 'package.json'));
    if (fs.existsSync(dist)) fs.renameSync(dist, `${dist}.previous`);
    fs.renameSync(`${dist}.next`, dist);
    fs.rmSync(`${dist}.previous`, { recursive: true, force: true });
    await execAsync(`cp -f "${path.join(BUNDLE_DIR, VERSION_FILE)}" "${path.join(INSTALLED_DIR, VERSION_FILE)}"`, { timeout: 15000 });

    if (!fs.existsSync(path.join(INSTALLED_DIR, 'node_modules'))) {
      try {
        await execAsync('npm install --omit=dev', { cwd: INSTALLED_DIR, timeout: 120000, env });
      } catch (err) {
        logger.warn('Watchdog node_modules install failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // `-k` kills the running instance and relaunches it under the same launchd label. On failure the old
    // watchdog keeps running under KeepAlive and the next update retries.
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid !== null) {
        await execAsync(`launchctl kickstart -k gui/${uid}/${WATCHDOG_LABEL}`, { timeout: 15000, env });
      }
    } catch (err) {
      logger.warn('Watchdog kickstart failed (non-fatal); launchd KeepAlive will pick up the new dist on its own', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Installed watchdog refreshed from platform bundle', { version: bundle.version });
    return { refreshed: true, reason: opts.force ? 'forced' : 'newer-bundle' };
  } catch (err) {
    logger.warn('Watchdog refresh failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { refreshed: false, reason: 'error' };
  }
}
