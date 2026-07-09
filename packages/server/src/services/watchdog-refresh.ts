// ════════════════════════════════════════
// Watchdog self-refresh
//
// Closes the watchdog-delivery gap in in-app updates. The in-app updater only
// rewrites ~/.dojo/platform; the watchdog lives at ~/.dojo/watchdog and was never
// touched by an update. So every stable box carried its OLD watchdog through the
// first jump to a new build, and the auto-rollback / read-only-WAL fixes that
// shipped in the watchdog never reached in-app-updating boxes at all.
//
// The fix ships the built watchdog INSIDE the platform package (platform/
// watchdog-dist, see deploy/build-package.sh) so it rides along inside the one
// directory the updater actually installs. This module installs that bundled
// watchdog over ~/.dojo/watchdog and kickstarts it:
//   • from index.ts, BEFORE runMigrations, so the patient NEW watchdog is the one
//     supervising the (potentially long) first-boot migration chain, even on a jump
//     from an old updater that could never refresh the watchdog itself; and
//   • from the updater (applyUpdate / rollback), so every future update keeps the
//     watchdog fresh going forward.
//
// Strictly best-effort: it must NEVER fail a boot or an update. It is a no-op on
// non-darwin, on a dev checkout (no ~/.dojo/watchdog), or when the bundle is
// absent (an older package that predates bundling).
// ════════════════════════════════════════

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logger.js';
import { compareVersions } from '../gateway/routes/update.js';

const execAsync = promisify(exec);
const logger = createLogger('watchdog-refresh');

const DOJO_DIR = path.join(os.homedir(), '.dojo');
const PLATFORM_DIR = path.join(DOJO_DIR, 'platform');
// The watchdog ships INSIDE platform/ so a self-update (which only rewrites
// ~/.dojo/platform) still delivers it. deploy/build-package.sh assembles this.
const BUNDLE_DIR = path.join(PLATFORM_DIR, 'watchdog-dist');
// Where install.sh installs the runnable watchdog + its (native) node_modules.
const INSTALLED_DIR = path.join(DOJO_DIR, 'watchdog');
// "<platformVersion> <shortContentHash>" written into the bundle at build time and
// copied alongside the installed watchdog so the next boot can compare the two.
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

// Refresh when: no installed marker (a pre-marker watchdog / the very first jump),
// OR the bundle's platform version is strictly newer, OR the versions match but the
// content hash differs (a same-version watchdog rebuild). This deliberately does
// NOT refresh on an equal marker, so a normal restart never needlessly kickstarts
// the watchdog.
function shouldRefresh(bundle: WatchdogVersion, installed: WatchdogVersion | null): boolean {
  if (!installed) return true;
  const cmp = compareVersions(bundle.version, installed.version);
  if (cmp > 0) return true;
  if (cmp === 0 && bundle.hash !== '' && bundle.hash !== installed.hash) return true;
  return false;
}

export interface WatchdogRefreshResult {
  refreshed: boolean;
  /** Machine-readable outcome for logs/tests. */
  reason: string;
}

/**
 * Install the platform-bundled watchdog over ~/.dojo/watchdog and kickstart it.
 *
 * opts.force skips the version comparison and always refreshes; the updater uses
 * it right after swapping the platform tree (the watchdog-dist there is, by
 * definition, the build we just installed). The boot path leaves it false so an
 * ordinary restart is a no-op.
 *
 * Never throws.
 */
export async function refreshBundledWatchdog(opts: { force?: boolean } = {}): Promise<WatchdogRefreshResult> {
  try {
    // Dev boxes / non-mac: there is no launchd watchdog job to manage.
    if (process.platform !== 'darwin') return { refreshed: false, reason: 'not-darwin' };
    // The installed watchdog dir is created by install.sh; its absence means this
    // is not a standard production box (a dev checkout), so there is nothing to
    // refresh or kickstart.
    if (!fs.existsSync(INSTALLED_DIR)) return { refreshed: false, reason: 'no-installed-watchdog' };
    // An older package that predates bundling ships nothing here.
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

    // Copy the built code + manifest + version marker over the installed watchdog,
    // PRESERVING node_modules. install.sh runs `npm ci --production` in the watchdog
    // dir at install time, so the native (better-sqlite3) build already lives at
    // ~/.dojo/watchdog/node_modules; the bundle intentionally ships no node_modules
    // (mirrors deploy/build-package.sh), and we must not delete the compiled one.
    // rsync the dist subtree with --delete so stale compiled files are removed, then
    // copy package.json + the version marker beside it (node_modules is a sibling of
    // dist, so --delete on dist never touches it).
    await execAsync(`rsync -a --delete "${path.join(BUNDLE_DIR, 'dist')}/" "${path.join(INSTALLED_DIR, 'dist')}/"`, { timeout: 30000, env });
    await execAsync(`cp -f "${path.join(BUNDLE_DIR, 'package.json')}" "${path.join(INSTALLED_DIR, 'package.json')}"`, { timeout: 15000 });
    await execAsync(`cp -f "${path.join(BUNDLE_DIR, VERSION_FILE)}" "${path.join(INSTALLED_DIR, VERSION_FILE)}"`, { timeout: 15000 });

    // Native deps: the preserved node_modules covers the (unchanged) better-sqlite3
    // dependency. Only when it is entirely absent (a box that somehow lost it) do we
    // rebuild it, mirroring install.sh. Best-effort; the already-copied code still
    // runs against whatever node_modules is present.
    if (!fs.existsSync(path.join(INSTALLED_DIR, 'node_modules'))) {
      try {
        await execAsync('npm install --omit=dev', { cwd: INSTALLED_DIR, timeout: 120000, env });
      } catch (err) {
        logger.warn('Watchdog node_modules install failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Restart the watchdog so the new dist takes over. `-k` kills the running
    // instance and relaunches it under the same launchd label. Best-effort: on any
    // failure the OLD watchdog keeps running under launchd KeepAlive and the next
    // update retries.
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
