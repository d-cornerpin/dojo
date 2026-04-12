// ════════════════════════════════════════
// Update System: Check for and apply updates from GitHub releases
// ════════════════════════════════════════

import { Hono } from 'hono';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';

const execAsync = promisify(exec);
const logger = createLogger('updater');

const GITHUB_REPO = 'd-cornerpin/dojo';
const PLATFORM_DIR = path.join(os.homedir(), '.dojo', 'platform');

function getCurrentVersion(): string {
  // Try reading from the installed platform's package.json first
  try {
    const pkgPath = path.join(PLATFORM_DIR, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version ?? '0.0.0';
    }
  } catch { /* fall through */ }

  // Fallback: read from source package.json (dev mode)
  try {
    // Walk up from dist/server to find root package.json
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'dojo-platform') return pkg.version ?? '0.0.0';
      }
      dir = path.dirname(dir);
    }
  } catch { /* fall through */ }

  return '0.0.0';
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const updateRouter = new Hono<AppEnv>();

// ── Check for updates ──

updateRouter.get('/check', async (c) => {
  const currentVersion = getCurrentVersion();

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return c.json({ ok: true, data: { currentVersion, latestVersion: null, updateAvailable: false, error: `GitHub API: ${response.status}` } });
    }

    const release = await response.json() as { tag_name: string; name: string; published_at: string; body: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
    const latestVersion = release.tag_name.replace(/^v/, '');
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    return c.json({
      ok: true,
      data: {
        currentVersion,
        latestVersion,
        latestTag: release.tag_name,
        releaseName: release.name,
        publishedAt: release.published_at,
        releaseNotes: release.body?.slice(0, 1000) ?? null,
        updateAvailable,
        downloadUrl: zipAsset?.browser_download_url ?? null,
        downloadSize: zipAsset?.size ?? null,
      },
    });
  } catch (err) {
    return c.json({ ok: true, data: { currentVersion, latestVersion: null, updateAvailable: false, error: err instanceof Error ? err.message : String(err) } });
  }
});

// ── Current version ──

updateRouter.get('/version', (c) => {
  return c.json({ ok: true, data: { version: getCurrentVersion() } });
});

// ── List recent releases (for rollback) ──

updateRouter.get('/releases', async (c) => {
  const currentVersion = getCurrentVersion();

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=15`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return c.json({ ok: false, error: `GitHub API: ${response.status}` }, 502);
    }

    const releases = await response.json() as Array<{
      tag_name: string;
      name: string;
      published_at: string;
      body: string;
      assets: Array<{ name: string; browser_download_url: string; size: number }>;
    }>;

    const data = releases.map(r => {
      const version = r.tag_name.replace(/^v/, '');
      const zipAsset = r.assets.find(a => a.name === 'dojo-platform.zip');
      return {
        version,
        tag: r.tag_name,
        name: r.name,
        publishedAt: r.published_at,
        notes: r.body?.slice(0, 300) ?? null,
        downloadUrl: zipAsset?.browser_download_url ?? null,
        downloadSize: zipAsset?.size ?? null,
        isCurrent: version === currentVersion,
      };
    });

    return c.json({ ok: true, data: { currentVersion, releases: data } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Rollback to a specific version ──

updateRouter.post('/rollback', async (c) => {
  const currentVersion = getCurrentVersion();
  const body = await c.req.json().catch(() => null);
  if (!body?.tag) {
    return c.json({ ok: false, error: 'tag is required (e.g. "v1.12.0")' }, 400);
  }

  const targetTag = body.tag as string;
  const targetVersion = targetTag.replace(/^v/, '');

  const isProduction = fs.existsSync(PLATFORM_DIR) && fs.existsSync(path.join(PLATFORM_DIR, 'package.json'));
  if (!isProduction) {
    return c.json({ ok: false, error: 'Rollback only supported for production installs (~/.dojo/platform).' }, 400);
  }

  try {
    // Fetch the specific release
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${targetTag}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return c.json({ ok: false, error: `Release ${targetTag} not found on GitHub (HTTP ${response.status})` }, 404);
    }

    const release = await response.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    if (!zipAsset) {
      return c.json({ ok: false, error: `No dojo-platform.zip found in release ${targetTag}` }, 500);
    }

    logger.info('Starting rollback', { from: currentVersion, to: targetVersion, url: zipAsset.browser_download_url });

    // Same process as apply: download → extract → backup → copy → npm install → restart
    const tmpDir = path.join(os.tmpdir(), `dojo-rollback-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'dojo-platform.zip');

    await execAsync(`curl -L -o "${zipPath}" "${zipAsset.browser_download_url}"`, { timeout: 120000 });
    await execAsync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { timeout: 60000 });

    const extractedDir = path.join(tmpDir, 'dojo-platform', 'platform');
    if (!fs.existsSync(extractedDir)) {
      return c.json({ ok: false, error: 'Extracted zip does not contain dojo-platform/platform directory' }, 500);
    }

    // Backup current
    const backupDir = `${PLATFORM_DIR}.backup-${currentVersion}`;
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true });
    logger.info('Backing up current platform for rollback', { from: PLATFORM_DIR, to: backupDir });
    await execAsync(`cp -R "${PLATFORM_DIR}" "${backupDir}"`, { timeout: 30000 });

    // Copy files (same logic as apply)
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
    const entries = fs.readdirSync(extractedDir);
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const src = path.join(extractedDir, entry);
      const dest = path.join(PLATFORM_DIR, entry);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        await execAsync(`rsync -a --delete "${src}/" "${dest}/"`, { timeout: 30000, env });
      } else {
        await execAsync(`cp -f "${src}" "${dest}"`, { timeout: 30000 });
      }
    }

    await execAsync('npm install --omit=dev', { cwd: PLATFORM_DIR, timeout: 120000, env });
    fs.rmSync(tmpDir, { recursive: true });

    logger.info('Rollback complete', { from: currentVersion, to: targetVersion });

    setTimeout(() => {
      logger.info('Restarting server after rollback');
      process.exit(0);
    }, 1000);

    return c.json({
      ok: true,
      data: {
        message: `Rolled back from ${currentVersion} to ${targetVersion}. Server is restarting...`,
        previousVersion: currentVersion,
        newVersion: targetVersion,
        backupDir,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Rollback failed', { error: msg });
    return c.json({ ok: false, error: `Rollback failed: ${msg}` }, 500);
  }
});

// ── Apply update ──

updateRouter.post('/apply', async (c) => {
  const currentVersion = getCurrentVersion();

  // Check if we're in a production install (platform dir exists)
  const isProduction = fs.existsSync(PLATFORM_DIR) && fs.existsSync(path.join(PLATFORM_DIR, 'package.json'));

  if (!isProduction) {
    return c.json({ ok: false, error: 'Updates are only supported for production installs (~/.dojo/platform). For development, use git pull.' }, 400);
  }

  try {
    // 1. Get the latest release download URL
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return c.json({ ok: false, error: `Failed to check GitHub releases: ${response.status}` }, 500);
    }

    const release = await response.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    if (!zipAsset) {
      return c.json({ ok: false, error: 'No dojo-platform.zip found in latest release' }, 500);
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return c.json({ ok: true, data: { message: 'Already up to date', version: currentVersion } });
    }

    logger.info('Starting update', { from: currentVersion, to: latestVersion, url: zipAsset.browser_download_url });

    // 2. Download the zip to a temp location
    const tmpDir = path.join(os.tmpdir(), `dojo-update-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'dojo-platform.zip');

    await execAsync(`curl -L -o "${zipPath}" "${zipAsset.browser_download_url}"`, { timeout: 120000 });

    // 3. Extract the zip
    await execAsync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { timeout: 60000 });

    // 4. Find the extracted platform directory
    // The zip structure is: dojo-platform/platform/{packages,package.json,...}
    const extractedDir = path.join(tmpDir, 'dojo-platform', 'platform');
    if (!fs.existsSync(extractedDir)) {
      // Fallback: maybe zip structure changed
      const fallback = path.join(tmpDir, 'dojo-platform');
      if (fs.existsSync(path.join(fallback, 'package.json'))) {
        // package.json at top level means flat structure
        return c.json({ ok: false, error: 'Unexpected zip structure -- package.json at dojo-platform/ root' }, 500);
      }
      return c.json({ ok: false, error: 'Extracted zip does not contain dojo-platform/platform directory' }, 500);
    }

    // 5. Backup the current platform
    const backupDir = `${PLATFORM_DIR}.backup-${currentVersion}`;
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true });
    }
    logger.info('Backing up current platform', { from: PLATFORM_DIR, to: backupDir });
    await execAsync(`cp -R "${PLATFORM_DIR}" "${backupDir}"`, { timeout: 30000 });

    // 6. Copy new files over (preserve node_modules, data, secrets)
    // Use rsync to properly overwrite existing directories
    // --delete ensures old files that no longer exist in the update are removed
    const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
    const entries = fs.readdirSync(extractedDir);
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const src = path.join(extractedDir, entry);
      const dest = path.join(PLATFORM_DIR, entry);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        // For directories: rsync with trailing slashes to merge/overwrite properly
        await execAsync(`rsync -a --delete "${src}/" "${dest}/"`, { timeout: 30000, env });
      } else {
        // For files: simple copy
        await execAsync(`cp -f "${src}" "${dest}"`, { timeout: 30000 });
      }
    }

    logger.info('Files updated, running npm install');

    // 7. Install production dependencies (no build needed -- zip includes pre-compiled dist/)
    await execAsync('npm install --omit=dev', { cwd: PLATFORM_DIR, timeout: 120000, env });

    // 8. Clean up temp files
    fs.rmSync(tmpDir, { recursive: true });

    logger.info('Update complete', { from: currentVersion, to: latestVersion });

    // 9. Send success response before restarting
    // Use a small delay so the response gets sent
    setTimeout(() => {
      logger.info('Restarting server after update');
      process.exit(0); // launchd will restart us
    }, 1000);

    return c.json({
      ok: true,
      data: {
        message: `Updated from ${currentVersion} to ${latestVersion}. Server is restarting...`,
        previousVersion: currentVersion,
        newVersion: latestVersion,
        backupDir,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Update failed', { error: msg });
    return c.json({ ok: false, error: `Update failed: ${msg}` }, 500);
  }
});
