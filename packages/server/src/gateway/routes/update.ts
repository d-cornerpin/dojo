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
const DOJO_DIR = path.join(os.homedir(), '.dojo');

// Per-update backup directories live as siblings of PLATFORM_DIR:
//   ~/.dojo/platform                  (current install)
//   ~/.dojo/platform.backup-2.7.16    (one per prior version)
//   ~/.dojo/platform.backup-2.7.15
//   ...
// Each backup is a full copy of node_modules + dist + dashboards, easily
// 100-200MB. Without pruning these accumulate forever and have been
// reported to fill mac mini disks. Keep MAX_BACKUPS_TO_KEEP most recent
// after each update (1 = the one we just made + nothing else; 2 gives
// us a second deeper rollback option). Default 2.
const BACKUP_PREFIX = 'platform.backup-';
const MAX_BACKUPS_TO_KEEP = 2;

interface BackupInfo {
  name: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

function listPlatformBackups(): BackupInfo[] {
  if (!fs.existsSync(DOJO_DIR)) return [];
  const entries = fs.readdirSync(DOJO_DIR);
  const backups: BackupInfo[] = [];
  for (const name of entries) {
    if (!name.startsWith(BACKUP_PREFIX)) continue;
    const fullPath = path.join(DOJO_DIR, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    backups.push({
      name,
      path: fullPath,
      mtimeMs: stat.mtimeMs,
      sizeBytes: dirSizeBytes(fullPath),
    });
  }
  return backups;
}

function dirSizeBytes(dir: string): number {
  // Walk the tree; reasonably fast for ~100-200MB platform backups since
  // it's a single-shot stat walk, no I/O on file contents.
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = fs.readdirSync(cur); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

function pruneOldBackups(keep: number = MAX_BACKUPS_TO_KEEP): { deleted: string[]; freedBytes: number } {
  const backups = listPlatformBackups();
  // Newest first.
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = backups.slice(keep);
  const deleted: string[] = [];
  let freedBytes = 0;
  for (const b of toDelete) {
    try {
      fs.rmSync(b.path, { recursive: true, force: true });
      deleted.push(b.name);
      freedBytes += b.sizeBytes;
    } catch (err) {
      logger.warn('Failed to delete old backup', { name: b.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (deleted.length > 0) {
    logger.info('Pruned old platform backups', { deleted, freedMB: Math.round(freedBytes / (1024 * 1024)), keep });
  }
  return { deleted, freedBytes };
}

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

    try {
      pruneOldBackups();
    } catch (err) {
      logger.warn('Backup prune after rollback failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }

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

    // Note: system-dependency installation (brew packages like whisper-cpp)
    // runs at server STARTUP via packages/server/src/services/ensure-system-deps.ts,
    // not here. That way deps get installed on the next launchd-driven reboot
    // regardless of which old version's update.ts shipped the files.

    // 8. Clean up temp files
    fs.rmSync(tmpDir, { recursive: true });

    // 8b. Prune old backups - keep just the last MAX_BACKUPS_TO_KEEP so
    // these don't fill the disk over many releases. Best-effort: if any
    // delete fails, the update still succeeds.
    try {
      pruneOldBackups();
    } catch (err) {
      logger.warn('Backup prune after update failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }

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

// ── Backup listing + manual cleanup ──
// Auto-prune runs after every update/rollback (keeps the last 2). This
// endpoint pair gives the user a way to inspect and free space on demand
// for installs where backups have already piled up.

updateRouter.get('/backups', (c) => {
  try {
    const backups = listPlatformBackups();
    backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const totalBytes = backups.reduce((sum, b) => sum + b.sizeBytes, 0);
    return c.json({
      ok: true,
      data: {
        count: backups.length,
        totalBytes,
        totalMB: Math.round(totalBytes / (1024 * 1024)),
        keepDefault: MAX_BACKUPS_TO_KEEP,
        backups: backups.map(b => ({
          name: b.name,
          version: b.name.slice(BACKUP_PREFIX.length),
          mtime: new Date(b.mtimeMs).toISOString(),
          sizeBytes: b.sizeBytes,
          sizeMB: Math.round(b.sizeBytes / (1024 * 1024)),
        })),
      },
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

updateRouter.post('/backups/cleanup', async (c) => {
  // Body: { keep?: number } - how many recent backups to retain. Defaults
  // to 1 (manual cleanup implies "free space now"; the most recent one is
  // still kept as a single-step rollback escape hatch).
  const body = await c.req.json().catch(() => ({} as { keep?: number }));
  const keep = typeof body.keep === 'number' && body.keep >= 0 ? Math.floor(body.keep) : 1;
  try {
    const { deleted, freedBytes } = pruneOldBackups(keep);
    const remaining = listPlatformBackups().length;
    return c.json({
      ok: true,
      data: {
        deleted,
        deletedCount: deleted.length,
        freedBytes,
        freedMB: Math.round(freedBytes / (1024 * 1024)),
        kept: keep,
        remaining,
      },
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
