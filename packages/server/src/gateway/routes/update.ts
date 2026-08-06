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
import { getDb } from '../../db/connection.js';
import { readLastMigrationBackup } from '../../db/migration-backup.js';
import { markPendingUpdate, markBootingNew } from '../../update-state.js';
import { routeFailure } from './route-failure.js';
import { ARTIFACT_MANIFEST_ASSET, fetchArtifactManifest, verifyArtifactAgainstManifest } from '../../update/artifact-integrity.js';

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
// A build that failed to boot and was set aside by rollback.sh for diagnosis
// (`platform.failed-<version>-<YYYYMMDD>-<HHMMSS>`). These are also 100-200MB
// each and, before FA-D5, nothing ever deleted them, so a box that hit a few
// bad updates slowly filled its disk with dead trees. They now age out on the
// SAME prune schedule as backups (keep the newest MAX_BACKUPS_TO_KEEP).
const FAILED_PREFIX = 'platform.failed-';
const MAX_BACKUPS_TO_KEEP = 2;

interface BackupInfo {
  name: string;
  path: string;
  mtimeMs: number;
  /** Version parsed from the dir NAME (not mtime). See FA-D5. */
  version: string;
}

// Fast listing: stat each backup dir's mtime (single syscall per entry).
// Pre-v2.7.19 also walked the full tree to compute byte size, which on a
// host with many backups stalled the settings page for minutes and burst
// past Cloudflare's 100s timeout. Sizes are no longer reported in the
// listing - the dashboard just shows count.
// Parse the version encoded in a directory name.
//   platform.backup-<version>                      → <version>
//   platform.failed-<version>-<YYYYMMDD>-<HHMMSS>  → <version>
// (<version> itself may carry a `-preflight.N` suffix, so strip only the
// trailing 8-digit + 6-digit timestamp rollback.sh stamps on failed builds.)
function backupVersionFromName(name: string): string {
  return name.slice(BACKUP_PREFIX.length);
}
function failedVersionFromName(name: string): string {
  return name.slice(FAILED_PREFIX.length).replace(/-\d{8}-\d{6}$/, '');
}

function listDirsWithPrefix(prefix: string, versionOf: (name: string) => string): BackupInfo[] {
  if (!fs.existsSync(DOJO_DIR)) return [];
  const out: BackupInfo[] = [];
  for (const name of fs.readdirSync(DOJO_DIR)) {
    if (!name.startsWith(prefix)) continue;
    const fullPath = path.join(DOJO_DIR, name);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    out.push({ name, path: fullPath, mtimeMs: stat.mtimeMs, version: versionOf(name) });
  }
  return out;
}

function listPlatformBackups(): BackupInfo[] {
  return listDirsWithPrefix(BACKUP_PREFIX, backupVersionFromName);
}

function listFailedBuilds(): BackupInfo[] {
  return listDirsWithPrefix(FAILED_PREFIX, failedVersionFromName);
}

// Newest first, BY PARSED VERSION (FA-D5). The dir mtime only breaks ties
// between two dirs that parse to the same version, so a touched mtime, or a
// prune interrupted by process.exit, can no longer restore the wrong build
// while deleting the right one. This is the ordering both the prune (what to
// delete) and a rollback (what to keep as the newest target) must use.
function sortNewestFirst(list: BackupInfo[]): BackupInfo[] {
  return [...list].sort((a, b) => {
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
    return b.mtimeMs - a.mtimeMs;
  });
}

// Async pruning: shell out to `rm -rf` (much faster than fs.rmSync since
// it's native C and doesn't block the event loop) and run targets in
// parallel. Returns a promise that resolves when all deletions complete.
// Caller decides whether to await or fire-and-forget.
async function pruneOldBackupsAsync(keep: number = MAX_BACKUPS_TO_KEEP): Promise<{ deleted: string[]; failed: Array<{ name: string; error: string }> }> {
  // Two independent pools, each capped to `keep` newest BY VERSION (FA-D5):
  //   platform.backup-* , real rollback targets (keep >= 1 always, so a box
  //                        never prunes itself out of a recovery option).
  //   platform.failed-* , broken builds rollback.sh set aside for diagnosis;
  //                        before FA-D5 nothing deleted these and they filled
  //                        the disk. Same schedule, same keep count.
  const toDelete = [
    ...sortNewestFirst(listPlatformBackups()).slice(keep),
    ...sortNewestFirst(listFailedBuilds()).slice(keep),
  ];
  const deleted: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const results = await Promise.allSettled(
    toDelete.map(async b => {
      // Shell `rm -rf` is dramatically faster than Node's fs.rmSync for
      // recursive deletes on large trees (node_modules has tens of
      // thousands of small files). Empty timeout - we want this to take
      // however long it needs; the caller controls flow via fire-and-forget.
      await execAsync(`rm -rf "${b.path}"`, { timeout: 0 });
      return b.name;
    }),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      deleted.push(r.value);
    } else {
      failed.push({ name: toDelete[i].name, error: String(r.reason) });
    }
  }

  if (deleted.length > 0) {
    logger.info('Pruned old platform backups + failed builds', { deleted, keep });
  }
  if (failed.length > 0) {
    logger.warn('Some backup/failed-build deletions failed', { failed });
  }
  return { deleted, failed };
}

// Boot-time entry point (FA-D5): bound both backup pools on every startup so a
// prune the post-update fire-and-forget didn't finish (it races the scheduled
// process.exit) still completes on the next launch. Awaitable + best-effort.
export async function pruneOldBackupsAsyncAtBoot(): Promise<void> {
  await pruneOldBackupsAsync();
}

// Module-level cleanup state. Single in-flight cleanup at a time; status
// is pollable via GET /api/update/backups/cleanup/status. State lives in
// memory only - if the server restarts mid-cleanup, the dashboard polls,
// sees inProgress=false, refreshes the listing, and observes whatever
// `rm -rf` finished before the restart.
interface CleanupState {
  inProgress: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  deleted: string[];
  failed: Array<{ name: string; error: string }>;
  targetCount: number; // how many we planned to delete
  error: string | null;
}
let cleanupState: CleanupState = {
  inProgress: false,
  startedAt: null,
  finishedAt: null,
  deleted: [],
  failed: [],
  targetCount: 0,
  error: null,
};

export function getCurrentVersion(): string {
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

// Parse "X.Y.Z" or a preflight tag "X.Y.Z-preflight.N" into a comparable shape.
// `pre` is null for a normal (stable) release and the numeric ordinal for a
// pre-release.
function parseVersion(v: string): { base: number[]; pre: number | null } {
  const s = v.replace(/^v/, '');
  const dash = s.indexOf('-');
  const basePart = dash === -1 ? s : s.slice(0, dash);
  const preTag = dash === -1 ? '' : s.slice(dash + 1);
  // Clamp non-numeric segments to 0 (FA-D7). A malformed base ("3.x.1", a
  // hand-edited tag) would otherwise yield NaN, which BOTH scrambles the
  // preflight sort (NaN comparisons are never < or >) AND slips past
  // applyUpdate's downgrade guard, since `NaN <= 0` is false.
  const base = basePart.split('.').map(seg => {
    const n = Number(seg);
    return Number.isFinite(n) ? n : 0;
  });
  let pre: number | null = null;
  if (preTag) {
    const m = preTag.match(/(\d+)\s*$/);
    pre = m ? Number(m[1]) : 0;
  }
  return { base, pre };
}

// A well-formed release tag: vX.Y.Z with an optional pre-release suffix.
// Junk tags (a hand-created "nightly", a mis-typed tag) are filtered out
// BEFORE sorting so a NaN-parsed non-semver tag can never win the preflight
// selection and shadow the real latest release (FA-D7).
export function isValidVersionTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim());
}

// Semver-with-prerelease precedence. Same base version: a stable release
// (no suffix) outranks any pre-release of it (3.1.6 > 3.1.6-preflight.5), and
// two pre-releases compare by ordinal (-preflight.2 > -preflight.1). A higher
// base always wins (3.1.7-preflight.1 > 3.1.6). Plain X.Y.Z vs X.Y.Z behaves
// exactly as before, so Stable-channel comparisons are unchanged.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.base[i] ?? 0) - (pb.base[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;  // a stable, b pre-release
  if (pb.pre === null) return -1; // a pre-release, b stable
  return pa.pre - pb.pre;
}

/**
 * THE ROLLBACK ORDERING CHECK (PHASE-5 T6B). `/rollback` took the caller's
 * `tag` and interpolated it straight into a GitHub API URL — so a path-shaped
 * tag selected a DIFFERENT artifact, which was then rsynced with `--delete`
 * over the running install — and it never asked whether the target was
 * actually an EARLIER version. Two arms, and each is here for its own reason:
 *
 *   SHAPE — reaching another repository's zip through a crafted tag was never
 *   a capability anyone granted, so refusing it strengthens a guard rather
 *   than narrowing one. `isValidVersionTag` already existed and was not called.
 *
 *   ORDER — this door's job is going BACK. Forward movement is `applyUpdate`,
 *   which resolves the channel, records the update episode and drives the
 *   boot-attempt/auto-rollback machinery; a "rollback" to a newer tag bypassed
 *   all of it, so the refusal names that door and redirects the capability
 *   rather than removing it. MEASURED NARROWING, on the record: installing a
 *   specific NEWER-but-not-latest release from the Settings list is refused
 *   after this change — reachable instead by channel + Check for updates.
 *
 * A legitimate rollback must still work — it is the recovery path — and that is
 * a positive clause, not an assumption. The watchdog's AUTOMATIC rollback does
 * not come through here at all (it shells `~/.dojo/scripts/rollback.sh` against
 * a local backup), so this gate cannot stand between a wedged box and its
 * recovery. Full reasoning: `update/__tests__/artifact-integrity.test.ts`.
 */
export function authorizeRollbackTarget(
  tag: string,
  currentVersion: string,
): { ok: true; targetVersion: string } | { ok: false; error: string } {
  const trimmed = (tag ?? '').trim();
  if (!isValidVersionTag(trimmed)) {
    return { ok: false, error: `"${trimmed}" is not a version tag (expected e.g. "v3.1.16").` };
  }
  const targetVersion = trimmed.replace(/^v/, '');
  if (compareVersions(targetVersion, currentVersion) >= 0) {
    return {
      ok: false,
      error: `${targetVersion} is not earlier than the installed ${currentVersion}. Rollback only moves backward; use Check for updates to move forward.`,
    };
  }
  return { ok: true, targetVersion };
}

// ── Update channel (Stable / Preflight) ──

export type UpdateChannel = 'stable' | 'preflight';
const UPDATE_CHANNEL_KEY = 'update_channel';

export function getUpdateChannel(): UpdateChannel {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(UPDATE_CHANNEL_KEY) as { value: string } | undefined;
    return row?.value === 'preflight' ? 'preflight' : 'stable';
  } catch {
    return 'stable';
  }
}

export function setUpdateChannel(channel: UpdateChannel): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(UPDATE_CHANNEL_KEY, channel, channel);
}

interface GhRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

// Resolve the release a channel should update to.
//   stable    → GET /releases/latest (GitHub excludes drafts + pre-releases),
//               i.e. exactly the pre-channel behavior.
//   preflight → list releases (which DOES include pre-releases), drop drafts,
//               and return the highest by version precedence — so a Preflight
//               box rides the newest pre-release, and automatically takes a
//               Stable release once its version overtakes the latest pre-release.
async function resolveLatestRelease(channel: UpdateChannel): Promise<GhRelease | null> {
  if (channel === 'stable') {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    return await res.json() as GhRelease;
  }
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`, {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
  const all = await res.json() as GhRelease[];
  // Filter out drafts AND any non-semver tag (FA-D7) so junk can't win the sort.
  const candidates = all.filter(r => !r.draft && isValidVersionTag(r.tag_name));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return candidates[0];
}

// ── Reusable core (shared by the routes and the agent's update tools) ──

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  latestTag?: string;
  releaseName?: string;
  publishedAt?: string;
  releaseNotes?: string | null;
  updateAvailable: boolean;
  downloadUrl?: string | null;
  downloadSize?: number | null;
  /** Which channel this result was resolved against. */
  channel?: UpdateChannel;
  error?: string;
}

/**
 * Read-only update check: compares the installed version against the latest
 * release on the given channel (defaults to the saved channel). Never throws —
 * network/API problems come back as `error` with `updateAvailable: false` so
 * callers can surface them plainly.
 */
export async function checkForUpdate(channel?: UpdateChannel): Promise<UpdateCheckResult> {
  const ch = channel ?? getUpdateChannel();
  const currentVersion = getCurrentVersion();
  try {
    const release = await resolveLatestRelease(ch);
    if (!release) {
      return { currentVersion, latestVersion: null, updateAvailable: false, channel: ch };
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    return {
      currentVersion,
      latestVersion,
      latestTag: release.tag_name,
      releaseName: release.name,
      publishedAt: release.published_at,
      releaseNotes: release.body?.slice(0, 1000) ?? null,
      updateAvailable,
      downloadUrl: zipAsset?.browser_download_url ?? null,
      downloadSize: zipAsset?.size ?? null,
      channel: ch,
    };
  } catch (err) {
    return { currentVersion, latestVersion: null, updateAvailable: false, channel: ch, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Cached daily update snapshot ──
// The update checker (services/update-checker.ts) writes a fresh snapshot here
// once a day so the agent's check_for_update tool can read it without a GitHub
// round-trip per call (and without us spending a model call to push updates at
// anyone). The snapshot holds both the installed and latest versions plus the
// release notes, so "is there a new version + what's in it" is one DB read.

const UPDATE_CACHE_KEY = 'update_check_cache';

export interface UpdateCacheEntry extends UpdateCheckResult {
  /** When this snapshot was taken (ISO). */
  checkedAt: string;
  /** Consecutive failed daily checks; 0 when the last check succeeded (FA-D6). */
  consecutiveCheckFailures?: number;
  /** True once the check pipeline has failed UPDATE_CHECK_FAILURE_THRESHOLD times running. */
  checkPipelineFailing?: boolean;
}

// ── Update-check pipeline health (FA-D6) ──
// The daily check never throws, a GitHub outage, a renamed repo, or a
// sustained rate-limit comes back as `error` with updateAvailable:false.
// Left unobserved, a box can silently strand OFF updates (fixes included) for
// weeks. We count CONSECUTIVE failed checks; once they cross the threshold we
// raise a notify-only health signal (Healer diagnostic + owner-visible line).
// This is a signal about the CHECK PIPELINE, not an update notification: the
// no-push design is intact, we never auto-update and never nudge "update
// available" on our own.
export const UPDATE_CHECK_FAILURE_THRESHOLD = 7;

const FAIL_COUNT_KEY = 'update_check_consecutive_failures';
const FAILING_SINCE_KEY = 'update_check_failing_since'; // stamped once when we cross the bar; cleared on recovery
const LAST_ERROR_KEY = 'update_check_last_error';

function readConfigStr(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}
function writeConfigStr(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(key, value, value);
}
function clearConfig(key: string): void {
  try { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); } catch { /* best effort */ }
}

export interface UpdateCheckHealth {
  consecutiveFailures: number;
  /** consecutiveFailures >= UPDATE_CHECK_FAILURE_THRESHOLD */
  failing: boolean;
  threshold: number;
  /** When the pipeline first crossed the threshold (ISO), or null if healthy. */
  failingSince: string | null;
  lastError: string | null;
}

/** Current update-check pipeline health, read from config. Never throws. */
export function getUpdateCheckHealth(): UpdateCheckHealth {
  const consecutiveFailures = Number(readConfigStr(FAIL_COUNT_KEY) ?? '0') || 0;
  return {
    consecutiveFailures,
    failing: consecutiveFailures >= UPDATE_CHECK_FAILURE_THRESHOLD,
    threshold: UPDATE_CHECK_FAILURE_THRESHOLD,
    failingSince: readConfigStr(FAILING_SINCE_KEY),
    lastError: readConfigStr(LAST_ERROR_KEY),
  };
}

// Fold one check outcome into the counter. A successful check resets the whole
// failure state (the reset rule: cleared on the first success); a failed one
// bumps the count and, the FIRST time it crosses the threshold, stamps
// failingSince exactly once (alert-once, mirroring FA-W4/FA-X1). Never throws.
function recordUpdateCheckOutcome(result: UpdateCheckResult): UpdateCheckHealth {
  try {
    if (!result.error) {
      const prev = Number(readConfigStr(FAIL_COUNT_KEY) ?? '0') || 0;
      if (prev !== 0) writeConfigStr(FAIL_COUNT_KEY, '0');
      clearConfig(FAILING_SINCE_KEY);
      clearConfig(LAST_ERROR_KEY);
    } else {
      const next = (Number(readConfigStr(FAIL_COUNT_KEY) ?? '0') || 0) + 1;
      writeConfigStr(FAIL_COUNT_KEY, String(next));
      writeConfigStr(LAST_ERROR_KEY, result.error);
      if (next >= UPDATE_CHECK_FAILURE_THRESHOLD && !readConfigStr(FAILING_SINCE_KEY)) {
        writeConfigStr(FAILING_SINCE_KEY, new Date().toISOString());
        logger.warn('Update check has failed repeatedly; raising a health signal', {
          consecutiveFailures: next, threshold: UPDATE_CHECK_FAILURE_THRESHOLD, lastError: result.error,
        });
      }
    }
  } catch (err) {
    logger.warn('Failed to record update-check outcome', { error: err instanceof Error ? err.message : String(err) });
  }
  return getUpdateCheckHealth();
}

/** Hit GitHub, write the result to the DB cache, and return it. */
export async function refreshUpdateCache(): Promise<UpdateCacheEntry> {
  const result = await checkForUpdate();
  // Fold the outcome into the consecutive-failure counter (FA-D6) before we
  // build the cache entry, so the entry carries the current pipeline health.
  const health = recordUpdateCheckOutcome(result);
  const entry: UpdateCacheEntry = {
    ...result,
    checkedAt: new Date().toISOString(),
    consecutiveCheckFailures: health.consecutiveFailures,
    checkPipelineFailing: health.failing,
  };
  try {
    const json = JSON.stringify(entry);
    getDb().prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(UPDATE_CACHE_KEY, json, json);
  } catch (err) {
    logger.warn('Failed to write update cache', { error: err instanceof Error ? err.message : String(err) });
  }
  return entry;
}

/** Read the last cached snapshot, or null if the daily check hasn't run yet. */
export function getUpdateCache(): UpdateCacheEntry | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM config WHERE key = ?`)
      .get(UPDATE_CACHE_KEY) as { value: string } | undefined;
    if (!row?.value) return null;
    return JSON.parse(row.value) as UpdateCacheEntry;
  } catch {
    return null;
  }
}

export interface ApplyUpdateResult {
  ok: boolean;
  message: string;
  previousVersion?: string;
  newVersion?: string;
  backupDir?: string;
  /** Suggested HTTP status for the route wrapper when ok=false. */
  status?: number;
}

/**
 * Download + install the latest release, then schedule a process restart
 * (launchd brings us back up). Production installs only. Shared by the
 * POST /apply route and the agent's apply_update tool. The restart is
 * scheduled internally on success, mirroring the original route behavior.
 */
export async function applyUpdate(channel?: UpdateChannel): Promise<ApplyUpdateResult> {
  const ch = channel ?? getUpdateChannel();
  const currentVersion = getCurrentVersion();

  const isProduction = fs.existsSync(PLATFORM_DIR) && fs.existsSync(path.join(PLATFORM_DIR, 'package.json'));
  if (!isProduction) {
    return { ok: false, message: 'Updates are only supported for production installs (~/.dojo/platform). For development, use git pull.', status: 400 };
  }

  try {
    // 1. Resolve the channel's target release + its download URL
    let release: GhRelease | null;
    try {
      release = await resolveLatestRelease(ch);
    } catch (err) {
      return { ok: false, message: `Failed to check GitHub releases: ${err instanceof Error ? err.message : String(err)}`, status: 500 };
    }
    if (!release) {
      return { ok: false, message: `No release found on the ${ch} channel`, status: 500 };
    }
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    if (!zipAsset) {
      return { ok: false, message: 'No dojo-platform.zip found in the target release', status: 500 };
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { ok: true, message: 'Already up to date', newVersion: currentVersion };
    }

    logger.info('Starting update', { channel: ch, from: currentVersion, to: latestVersion, url: zipAsset.browser_download_url });

    // 2. Download the zip to a temp location
    const tmpDir = path.join(os.tmpdir(), `dojo-update-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'dojo-platform.zip');

    await execAsync(`curl -L -o "${zipPath}" "${zipAsset.browser_download_url}"`, { timeout: 120000 });

    // 2b. INTEGRITY BEFORE ANY SWAP (PHASE-5 T6B). Nothing is extracted and
    // nothing is rsynced until the bytes match the manifest published beside
    // them. A release with no manifest is applied and recorded as unverified —
    // every artifact published before this change has none, and refusing them
    // would end the rollback path. Reasoning: `update/artifact-integrity.ts`.
    const applyVerdict = await verifyArtifactAgainstManifest(
      zipPath,
      await fetchArtifactManifest(release.assets.find(a => a.name === ARTIFACT_MANIFEST_ASSET)?.browser_download_url),
    );
    if (applyVerdict.outcome === 'refused') {
      return { ok: false, message: `Update REFUSED — ${applyVerdict.reason}`, status: 502 };
    }

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
        return { ok: false, message: 'Unexpected zip structure -- package.json at dojo-platform/ root', status: 500 };
      }
      return { ok: false, message: 'Extracted zip does not contain dojo-platform/platform directory', status: 500 };
    }

    // 5. Backup the current platform
    const backupDir = `${PLATFORM_DIR}.backup-${currentVersion}`;
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true });
    }
    logger.info('Backing up current platform', { from: PLATFORM_DIR, to: backupDir });
    await execAsync(`cp -R "${PLATFORM_DIR}" "${backupDir}"`, { timeout: 30000 });
    // D-F: the update episode begins the moment a restorable backup exists.
    // The watchdog only ever auto-rolls-back when this marker proves a
    // self-update is in flight and failing, never on a generic outage.
    markPendingUpdate({ targetVersion: latestVersion, previousVersion: currentVersion, backupDir });

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

    // 6b. Refresh maintenance scripts (~/.dojo/scripts) from the package. The
    // rsync above only covers entries inside platform/; the launcher/recovery
    // scripts live as a sibling of platform/ in the package, so without this
    // step a script-level fix or a new tool (e.g. the menu-bar rollback's
    // rollback.sh) would only reach a box on a full reinstall. Best-effort: a
    // script-copy failure must never abort an otherwise-good update.
    try {
      const scriptsSrc = path.join(tmpDir, 'dojo-platform', 'scripts');
      const scriptsDest = path.join(path.dirname(PLATFORM_DIR), 'scripts');
      if (fs.existsSync(scriptsSrc)) {
        fs.mkdirSync(scriptsDest, { recursive: true });
        await execAsync(`cp -f "${scriptsSrc}/"*.sh "${scriptsDest}/" && chmod +x "${scriptsDest}/"*.sh`, { timeout: 30000, env });
        logger.info('Refreshed maintenance scripts from package', { dest: scriptsDest });
      }
    } catch (err) {
      logger.warn('Script refresh during update failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
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

    // 8a. Refresh the watchdog from the just-installed platform bundle and kickstart
    // it, so the NEW watchdog (with its auto-rollback + read-only-WAL fixes) takes
    // over BEFORE we hand off to the restarted build. The updater only rewrites
    // ~/.dojo/platform, so without this the watchdog would stay on the old code
    // forever. force=true because we KNOW the platform tree just changed; a no-op
    // when this box predates watchdog bundling. Best-effort: never fail an otherwise-
    // good update. Shared with the boot-time self-refresh.
    try {
      const { refreshBundledWatchdog } = await import('../../services/watchdog-refresh.js');
      const r = await refreshBundledWatchdog({ force: true });
      logger.info('Watchdog refresh after update', { refreshed: r.refreshed, reason: r.reason });
    } catch (err) {
      logger.warn('Watchdog refresh after update failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }

    // 8b. Prune old backups - fire-and-forget. Background `rm -rf` keeps
    // the apply response fast and never blocks Cloudflare's 100s timeout.
    pruneOldBackupsAsync().catch(err => {
      logger.warn('Backup prune after update failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });

    logger.info('Update complete', { from: currentVersion, to: latestVersion });

    // 9. Schedule the restart. Small delay so the caller's response (HTTP
    // body or tool result) flushes first; launchd restarts us.
    // D-F: flip the marker to booting-new right before the exit; the boot
    // sentinel + watchdog take the episode from here.
    markBootingNew();
    setTimeout(() => {
      logger.info('Restarting server after update');
      process.exit(0); // launchd will restart us
    }, 1000);

    return {
      ok: true,
      message: `Updated from ${currentVersion} to ${latestVersion}. Server is restarting...`,
      previousVersion: currentVersion,
      newVersion: latestVersion,
      backupDir,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Update failed', { error: msg });
    return { ok: false, message: `Update failed: ${msg}`, status: 500 };
  }
}

export const updateRouter = new Hono<AppEnv>();

// ── Check for updates ──

updateRouter.get('/check', async (c) => {
  return c.json({ ok: true, data: await checkForUpdate() });
});

// ── Update channel (Stable / Preflight) ──

updateRouter.get('/channel', (c) => {
  return c.json({ ok: true, data: { channel: getUpdateChannel() } });
});

updateRouter.post('/channel', async (c) => {
  const body = await c.req.json().catch(() => null);
  const channel = body?.channel;
  if (channel !== 'stable' && channel !== 'preflight') {
    return c.json({ ok: false, error: "channel must be 'stable' or 'preflight'" }, 400);
  }
  setUpdateChannel(channel);
  logger.info('Update channel changed', { channel });
  // Refresh the daily cache for the new channel so the UI AND the agent's
  // check_for_update tool (which reads that cache) are immediately consistent
  // with the switch — no stale old-channel snapshot.
  const check = await refreshUpdateCache();
  return c.json({ ok: true, data: { channel, check } });
});

// ── Current version ──

updateRouter.get('/version', (c) => {
  return c.json({ ok: true, data: { version: getCurrentVersion() } });
});

// ── The DATA backup: did the last update leave a way back? ──
//
// Distinct from `/backups` above, which lists copies of the APP (`platform.backup-*`).
// Restoring one of those puts the old code back and does not touch the database — so
// after a chain of migrations it does not undo anything the update did to the data.
// The only thing that undoes THAT is the pre-migration snapshot, and until this route
// existed nothing in the product could tell anyone whether one had been made. The
// answer is recorded by db/migration-backup.ts on the boot that ran the chain, so it
// survives the restart the update needs.
updateRouter.get('/db-backup', (c) => {
  try {
    return c.json({ ok: true, data: { backup: readLastMigrationBackup(getDb()) } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
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
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// ── Rollback to a specific version ──

updateRouter.post('/rollback', async (c) => {
  const currentVersion = getCurrentVersion();
  const body = await c.req.json().catch(() => null);
  if (!body?.tag) {
    return c.json({ ok: false, error: 'tag is required (e.g. "v1.12.0")' }, 400);
  }

  const targetTag = (body.tag as string).trim();
  // PHASE-5 T6B: the ordering + shape gate. Nothing is fetched until the target
  // is a version tag AND an earlier one than the installed build.
  const authorized = authorizeRollbackTarget(targetTag, currentVersion);
  if (!authorized.ok) {
    return c.json({ ok: false, error: authorized.error }, 400);
  }
  const targetVersion = authorized.targetVersion;

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

    // Same gate as apply, and it must be here too: this path also rsyncs with
    // `--delete` over the running install (PHASE-5 T6B).
    const rollbackVerdict = await verifyArtifactAgainstManifest(
      zipPath,
      await fetchArtifactManifest(release.assets.find(a => a.name === ARTIFACT_MANIFEST_ASSET)?.browser_download_url),
    );
    if (rollbackVerdict.outcome === 'refused') {
      return c.json({ ok: false, error: `Rollback REFUSED — ${rollbackVerdict.reason}` }, 502);
    }

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
    // D-F: a manual rollback is an update episode too (the restored build must
    // come up healthy or the watchdog escalates); same marker discipline.
    markPendingUpdate({ targetVersion, previousVersion: currentVersion, backupDir });

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

    // Refresh the watchdog from the just-restored platform bundle and kickstart it,
    // so the watchdog matches the build it now supervises (a rollback is an update
    // episode too). force=true because the platform tree just changed; a no-op if the
    // restored build predates watchdog bundling. Best-effort. Shared helper.
    try {
      const { refreshBundledWatchdog } = await import('../../services/watchdog-refresh.js');
      const r = await refreshBundledWatchdog({ force: true });
      logger.info('Watchdog refresh after rollback', { refreshed: r.refreshed, reason: r.reason });
    } catch (err) {
      logger.warn('Watchdog refresh after rollback failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }

    // Fire-and-forget: prune runs in background using rm -rf so it never
    // blocks the rollback's response and never trips Cloudflare timeouts.
    pruneOldBackupsAsync().catch(err => {
      logger.warn('Backup prune after rollback failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });

    logger.info('Rollback complete', { from: currentVersion, to: targetVersion });

    // D-F: same booting-new flip as the update path.
    markBootingNew();
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
  const result = await applyUpdate();
  if (!result.ok) {
    return c.json({ ok: false, error: result.message }, (result.status ?? 500) as 400 | 500);
  }
  const { ok: _ok, message, status: _status, ...rest } = result;
  return c.json({ ok: true, data: { message, ...rest } });
});

// ── Backup listing + manual cleanup ──
// Auto-prune runs after every update/rollback (keeps the last 2). This
// endpoint pair gives the user a way to inspect and free space on demand
// for installs where backups have already piled up.

// Fast listing - mtime + name only, no tree walks. Returns within ms even
// with hundreds of backups on disk.
updateRouter.get('/backups', (c) => {
  try {
    const backups = listPlatformBackups();
    backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return c.json({
      ok: true,
      data: {
        count: backups.length,
        keepDefault: MAX_BACKUPS_TO_KEEP,
        backups: backups.map(b => ({
          name: b.name,
          version: b.name.slice(BACKUP_PREFIX.length),
          mtime: new Date(b.mtimeMs).toISOString(),
        })),
      },
    });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// Cleanup: fire-and-forget. Returns 202 immediately; the actual `rm -rf`
// runs in the background. Dashboard polls GET /backups/cleanup/status.
updateRouter.post('/backups/cleanup', async (c) => {
  if (cleanupState.inProgress) {
    return c.json({
      ok: false,
      error: 'A cleanup is already in progress. Poll /api/update/backups/cleanup/status for completion.',
    }, 409);
  }

  const body = await c.req.json().catch(() => ({} as { keep?: number }));
  const keep = typeof body.keep === 'number' && body.keep >= 0 ? Math.floor(body.keep) : 1;

  // Snapshot the target count up front so the dashboard can show progress
  // ("Cleaning up 8 backups...") even before the first deletion completes.
  // The prune deletes all-but-`keep` of BOTH pools (backups AND failed
  // builds, FA-D5), so count both or the progress number under-reports.
  const backupCount = listPlatformBackups().length;
  const failedCount = listFailedBuilds().length;
  const targetCount = Math.max(0, backupCount - keep) + Math.max(0, failedCount - keep);

  if (targetCount === 0) {
    return c.json({
      ok: true,
      data: {
        status: 'noop',
        message: `No old backups or failed builds to delete (${backupCount} backup(s), ${failedCount} failed build(s) on disk, keeping ${keep} of each).`,
        kept: keep,
      },
    });
  }

  cleanupState = {
    inProgress: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    deleted: [],
    failed: [],
    targetCount,
    error: null,
  };

  // Run the prune as fire-and-forget. The Promise updates cleanupState
  // on completion; the response returns immediately so Cloudflare's 100s
  // budget is never an issue regardless of how long rm -rf takes.
  pruneOldBackupsAsync(keep)
    .then(({ deleted, failed }) => {
      cleanupState = {
        ...cleanupState,
        inProgress: false,
        finishedAt: new Date().toISOString(),
        deleted,
        failed,
      };
      logger.info('Manual backup cleanup completed', {
        deletedCount: deleted.length, failedCount: failed.length,
      });
    })
    .catch(err => {
      cleanupState = {
        ...cleanupState,
        inProgress: false,
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
      logger.error('Manual backup cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return c.json({
    ok: true,
    data: {
      status: 'started',
      targetCount,
      kept: keep,
      message: `Cleanup of ${targetCount} backup(s) started in the background. Poll status endpoint for completion.`,
    },
  }, 202);
});

// Poll endpoint for the dashboard. Returns the latest cleanup snapshot;
// inProgress=true means a cleanup is still running.
updateRouter.get('/backups/cleanup/status', (c) => {
  const remaining = listPlatformBackups().length;
  return c.json({
    ok: true,
    data: {
      inProgress: cleanupState.inProgress,
      startedAt: cleanupState.startedAt,
      finishedAt: cleanupState.finishedAt,
      deletedCount: cleanupState.deleted.length,
      failedCount: cleanupState.failed.length,
      targetCount: cleanupState.targetCount,
      error: cleanupState.error,
      remainingOnDisk: remaining,
    },
  });
});
