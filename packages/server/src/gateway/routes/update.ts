// Update system: check for and apply updates from GitHub releases.

import { Hono } from 'hono';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppEnv } from '../server.js';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { setConfigValue } from '../../config/config-value.js';
import { readLastMigrationBackup } from '../../db/migration-backup.js';
import { migrationAheadOfBuild } from '../../db/migrations.js';
import { markBootingNew, readMarker } from '../../update-state.js';
import { rollbackTargetPaths } from '../../update/rollback-target.js';
import { installPlatformTree, newInstallWorkDir, runNpmInstall, acquireSwapLock } from '../../update/install-tree.js';
import { episodeSummary } from '../../update-episode.js';
// The updater's long subprocesses are bounded by silence, not a flat total. The bound takes an
// already-spawned child, so this route keeps its own spawn (the toolbox's capability facade would refuse
// it).
import { attachIdleBound } from '../../child-idle-bound.js';
import { childFailureText, isUnnamedWriteFailure } from '../../update/child-failure.js';
import { routeFailure } from './route-failure.js';
import { cleanUpdateLeftovers } from '../../update/leftovers.js';
import { ARTIFACT_MANIFEST_ASSET, fetchArtifactManifest, verifyArtifactAgainstManifest } from '../../update/artifact-integrity.js';
import {
  measureUpdateDiskNeed, updateDiskRefusal, isOutOfSpaceError, outOfSpaceFailureMessage,
  type UpdateDiskNeed,
} from '../../update/disk-preflight.js';
import { homeDir } from '../../home.js';
import { missingStandardBytes } from '../../services/local-standard.js';

// No shell anywhere: every command is a program plus an argument array.
const execFileAsync = promisify(execFile);

// `curl` and `npm install` re-arm their bound on output (a stuck one dies, and the reason says silence),
// with a non-re-arming ceiling behind each. The install leg is runNpmInstall in update/install-tree.ts.
const UPDATE_DOWNLOAD_IDLE_MS = 60_000;
const UPDATE_DOWNLOAD_CEILING_MS = 60 * 60_000;

// The idle bound with no shell: `spawn(file, argv)` hands the arguments straight to `execve`, so the release
// asset URL (a value from outside the process) is data, never text inside a `/bin/sh -c` string.
async function spawnIdleBounded(
  file: string, argv: readonly string[],
  opts: { idleMs: number; ceilingMs: number },
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(file, [...argv]);
  return attachIdleBound(child, { idleMs: opts.idleMs, ceilingMs: opts.ceilingMs });
}

// The download argv. curl's own stall detector (--speed-limit/--speed-time) aborts only when the transfer
// sits below 1 KB/s for a whole minute; --connect-timeout bounds the handshake; our idle bound also covers
// curl wedging.
function curlDownloadArgv(url: string, dest: string): string[] {
  return [
    '-L', '--fail',   // no -s: the progress meter on stderr is the idle bound's only liveness signal
    '--connect-timeout', '30',
    '--speed-limit', '1024', '--speed-time', '60',
    '-o', dest,
    url,
  ];
}
const logger = createLogger('updater');

const GITHUB_REPO = 'd-cornerpin/dojo';
const PLATFORM_DIR = path.join(homeDir(), '.dojo', 'platform');
const DOJO_DIR = path.join(homeDir(), '.dojo');

// No `__dirname` in this ESM module (`"type": "module"`), so the directory comes from import.meta.url.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Per-update backups are siblings of PLATFORM_DIR, each the previous live tree itself (renamed aside, not
// copied, 100-200MB); only the MAX_BACKUPS_TO_KEEP most recent survive each update.
const BACKUP_PREFIX = 'platform.backup-';
// A build that failed to boot, set aside by rollback.sh for diagnosis (platform.failed-<version>-<stamp>);
// also 100-200MB, so it ages out on the same prune schedule as backups.
const FAILED_PREFIX = 'platform.failed-';
const MAX_BACKUPS_TO_KEEP = 2;

interface BackupInfo {
  name: string;
  path: string;
  mtimeMs: number;
  version: string;
}

// Listing stats mtimes only (a tree walk for sizes stalled the settings page). The version comes from the
// dir name; <v> may carry `-preflight.N`, so only the trailing `-YYYYMMDD-HHMMSS` stamp on failed builds is
// stripped.
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

// Newest first BY PARSED VERSION; the mtime only breaks ties, so a touched mtime or an interrupted prune
// cannot restore the wrong build while deleting the right one. Prune and rollback both use this ordering.
function sortNewestFirst(list: BackupInfo[]): BackupInfo[] {
  return [...list].sort((a, b) => {
    const v = compareVersions(b.version, a.version);
    if (v !== 0) return v;
    return b.mtimeMs - a.mtimeMs;
  });
}

function backupsToPrune(keep: number): BackupInfo[] {
  const targets = new Set(rollbackTargetPaths({
    dojoDir: DOJO_DIR, home: homeDir(), backupPrefix: BACKUP_PREFIX, recordedBackupDir: readMarker()?.backupDir,
    backupsNewestFirst: sortNewestFirst(listPlatformBackups()),
    readText: f => fs.readFileSync(f, 'utf-8'),
    exists: f => fs.existsSync(f),
    runScript: (script, flag, home) => execFileSync('/bin/bash', [script, flag], {
      env: { ...process.env, HOME: home }, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    }),
  }));
  return [
    ...sortNewestFirst(listPlatformBackups()).slice(keep),
    ...sortNewestFirst(listFailedBuilds()).slice(keep),
  ].filter(b => !targets.has(path.resolve(b.path)));
}

// Async pruning shells out to `rm -rf` (native, does not block the event loop) with targets in parallel; the
// caller decides whether to await or fire-and-forget.
async function pruneOldBackupsAsync(keep: number = MAX_BACKUPS_TO_KEEP): Promise<{ deleted: string[]; failed: Array<{ name: string; error: string }> }> {
  // Two pools, each capped to the `keep` newest BY VERSION: platform.backup-* (real rollback targets; keep
  // >= 1 so a box never prunes itself out of a recovery option) and platform.failed-* (broken builds set
  // aside for diagnosis). Work dirs of a dead installer are swept at boot by update/leftovers.ts, one owner.
  const toDelete = backupsToPrune(keep);
  const deleted: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  const results = await Promise.allSettled(
    toDelete.map(async b => {
      // No timeout: a large tree takes as long as it takes; callers control flow by awaiting or not.
      await execFileAsync('rm', ['-rf', b.path], { timeout: 0 });
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

// Boot-time entry point: bounds both backup pools on every startup, so a prune the post-update
// fire-and-forget did not finish (it races the scheduled process.exit) still completes on the next launch.
export async function pruneOldBackupsAsyncAtBoot(): Promise<void> {
  // Side by side: a sweep that is slow or stuck never holds the backup prune back.
  await Promise.allSettled([cleanUpdateLeftovers(DOJO_DIR), pruneOldBackupsAsync()]);
}

// One cleanup in flight, pollable via GET /api/update/backups/cleanup/status; state is memory-only.
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

/**
 * What this platform answers when it cannot read its own version. Not `'0.0.0'`: that is valid semver, so it
 * would pass the honest-absence checks (reportVersion, issueLabelsFor, the telemetry whitelist, which
 * substitutes its own marker first) that a non-version sentinel trips. Free of `-` because parseVersion
 * reads the first `-` as a pre-release suffix. Ordering uses `versionIsOrderable`.
 */
export const VERSION_UNREADABLE = '<unreadable>';

/** Reasons already reported. Only the LOG LINE is deduplicated; the answer never is. */
const versionFailuresReported = new Set<string>();

/** The sentinel, and the reason it is the sentinel, on the record. Never silent. */
function versionUnreadable(reason: string): string {
  if (!versionFailuresReported.has(reason)) {
    versionFailuresReported.add(reason);
    logger.error('the platform cannot read its own version', { reason, answering: VERSION_UNREADABLE });
  }
  return VERSION_UNREADABLE;
}

/**
 * The version this build is: one authority for the update check, rollback gate, release-step ledger, export
 * manifest, boot episode and the report tool. No `__dirname` exists in this ESM module, so the source walk
 * starts from MODULE_DIR. Every exit that is not a version names its reason and answers the sentinel. A
 * manifest that exists but will not parse stops here, not at the source walk: a corrupt installed
 * package.json is the fact worth reporting.
 */
export function getCurrentVersion(): string {
  // 1. The installed platform (every packaged install).
  const installed = path.join(PLATFORM_DIR, 'package.json');
  try {
    if (fs.existsSync(installed)) {
      const pkg = JSON.parse(fs.readFileSync(installed, 'utf-8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version;
      return versionUnreadable(`${installed} declares no version`);
    }
  } catch (err) {
    return versionUnreadable(`${installed} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Development: walk up from this module to the manifest NAMED `dojo-platform` (the first package.json
  // met is @dojo/server, not the platform). Six levels reach the root from both `src/` and `dist/` layouts.
  try {
    let dir = MODULE_DIR;
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: unknown; version?: unknown };
        if (pkg.name === 'dojo-platform') {
          if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version;
          return versionUnreadable(`${pkgPath} declares no version`);
        }
      }
      dir = path.dirname(dir);
    }
  } catch (err) {
    return versionUnreadable(
      `the source manifest walk from ${MODULE_DIR} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return versionUnreadable(
    `no installed platform at ${PLATFORM_DIR} and no dojo-platform package.json within six levels above ${MODULE_DIR}`,
  );
}

// Parse "X.Y.Z" or "X.Y.Z-preflight.N"; `pre` is null for a stable release, else the ordinal.
function parseVersion(v: string): { base: number[]; pre: number | null } {
  const s = v.replace(/^v/, '');
  const dash = s.indexOf('-');
  const basePart = dash === -1 ? s : s.slice(0, dash);
  const preTag = dash === -1 ? '' : s.slice(dash + 1);
  // Non-numeric segments clamp to 0: NaN would scramble the preflight sort and slip past applyUpdate's
  // downgrade guard (`NaN <= 0` is false).
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

// A well-formed release tag: vX.Y.Z with an optional pre-release suffix. Junk tags are filtered out BEFORE
// sorting so a NaN-parsed non-semver tag can never win the preflight selection.
export function isValidVersionTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag.trim());
}

// Semver precedence: a stable release outranks any pre-release of the same base (3.1.6 > 3.1.6-preflight.5),
// pre-releases compare by ordinal, and a higher base always wins.
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
 * Can this module order this version at all? The clamp in parseVersion makes an unreadable version
 * indistinguishable from `0.0.0` and a number has no room for "unknown", so each caller decides what unknown
 * means for its own door.
 */
export function versionIsOrderable(v: string): boolean {
  return isValidVersionTag(v);
}

/**
 * The rollback gate. SHAPE: the tag goes into a GitHub API URL and the artifact is rsynced with `--delete`
 * over the running install, so only a version tag may pass. ORDER: this door only goes BACK; forward
 * movement is `applyUpdate` (channel, boot-attempt and auto-rollback machinery), so a newer tag is refused.
 * The watchdog's automatic rollback shells rollback.sh against a local backup and never comes through here.
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
  // Fail closed on an unreadable installed version: "is the target earlier?" has no answer then. Refusing is
  // safe, since the watchdog's automatic rollback never comes through here.
  if (!versionIsOrderable(currentVersion)) {
    return {
      ok: false,
      error: `This box cannot read its own installed version (it reports ${currentVersion}), so it `
        + 'cannot tell whether ' + targetVersion + ' would be a step backward. Rollback is refused '
        + 'rather than guessed. Reinstall the platform, or use Check for updates to move forward.',
    };
  }
  if (compareVersions(targetVersion, currentVersion) >= 0) {
    return {
      ok: false,
      error: `${targetVersion} is not earlier than the installed ${currentVersion}. Rollback only moves backward; use Check for updates to move forward.`,
    };
  }
  return { ok: true, targetVersion };
}


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
  setConfigValue(UPDATE_CHANNEL_KEY, channel);
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

// Resolve the release a channel should update to. stable: GET /releases/latest (GitHub excludes drafts and
// pre-releases). preflight: list releases (pre-releases included), drop drafts, take the highest by version
// precedence, so a Preflight box rides the newest pre-release and takes a Stable one once it overtakes it.
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
  // Filter out drafts and non-semver tags so junk cannot win the sort.
  const candidates = all.filter(r => !r.draft && isValidVersionTag(r.tag_name));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return candidates[0];
}


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
  channel?: UpdateChannel;
  /**
   * The disk-space pre-flight for this release, measured at check time (the artifact's size is in the
   * release metadata this call already holds). Absent when there is no release to measure against.
   */
  disk?: UpdateDiskNeed;
  error?: string;
}

/**
 * Read-only update check against the latest release on the given channel (default: the saved one). Never
 * throws: network and API problems come back as `error` with `updateAvailable: false`.
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
      releaseNotes: release.body ?? null,
      updateAvailable,
      downloadUrl: zipAsset?.browser_download_url ?? null,
      downloadSize: zipAsset?.size ?? null,
      channel: ch,
      // Measured here, where the artifact's own size is in hand. Never allowed to fail a
      // check: a disk we cannot read must not make "is there an update?" unanswerable.
      disk: (() => {
        try { return measureUpdateDiskNeed({ artifactBytes: zipAsset?.size ?? 0, modelBytes: missingStandardBytes() }); }
        catch (err) {
          logger.debug('Update disk pre-flight failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      })(),
    };
  } catch (err) {
    return { currentVersion, latestVersion: null, updateAvailable: false, channel: ch, error: err instanceof Error ? err.message : String(err) };
  }
}

// Cached daily update snapshot: services/update-checker.ts writes one a day so the agent's check_for_update
// tool reads it without a GitHub round-trip per call.

const UPDATE_CACHE_KEY = 'update_check_cache';

export interface UpdateCacheEntry extends UpdateCheckResult {
  checkedAt: string;
  /** Consecutive failed daily checks; 0 when the last check succeeded. */
  consecutiveCheckFailures?: number;
  /** True once the check pipeline has failed UPDATE_CHECK_FAILURE_THRESHOLD times running. */
  checkPipelineFailing?: boolean;
}

// Update-check pipeline health: the daily check never throws (an outage comes back as `error`), so
// CONSECUTIVE failures are counted and, past the threshold, raise a notify-only health signal. It is not an
// update notice.
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
function clearConfig(key: string): void {
  try { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); } catch { /* best effort */ }
}

export interface UpdateCheckHealth {
  consecutiveFailures: number;
  failing: boolean;
  threshold: number;
  /** When the pipeline first crossed the threshold (ISO), or null if healthy. */
  failingSince: string | null;
  lastError: string | null;
}

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

// Fold one check outcome into the counter: a success resets all failure state; a failure bumps the count
// and, the first time it crosses the threshold, stamps failingSince once (alert once). Never throws.
function recordUpdateCheckOutcome(result: UpdateCheckResult): UpdateCheckHealth {
  try {
    if (!result.error) {
      const prev = Number(readConfigStr(FAIL_COUNT_KEY) ?? '0') || 0;
      if (prev !== 0) setConfigValue(FAIL_COUNT_KEY, '0');
      clearConfig(FAILING_SINCE_KEY);
      clearConfig(LAST_ERROR_KEY);
    } else {
      const next = (Number(readConfigStr(FAIL_COUNT_KEY) ?? '0') || 0) + 1;
      setConfigValue(FAIL_COUNT_KEY, String(next));
      setConfigValue(LAST_ERROR_KEY, result.error);
      if (next >= UPDATE_CHECK_FAILURE_THRESHOLD && !readConfigStr(FAILING_SINCE_KEY)) {
        setConfigValue(FAILING_SINCE_KEY, new Date().toISOString());
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

export async function refreshUpdateCache(): Promise<UpdateCacheEntry> {
  const result = await checkForUpdate();
  // Fold the outcome into the failure counter first, so the cache entry carries the current pipeline health.
  const health = recordUpdateCheckOutcome(result);
  const entry: UpdateCacheEntry = {
    ...result,
    checkedAt: new Date().toISOString(),
    consecutiveCheckFailures: health.consecutiveFailures,
    checkPipelineFailing: health.failing,
  };
  try {
    const json = JSON.stringify(entry);
    setConfigValue(UPDATE_CACHE_KEY, json);
  } catch (err) {
    logger.warn('Failed to write update cache', { error: err instanceof Error ? err.message : String(err) });
  }
  return entry;
}

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
  status?: number;
}

/**
 * Download, verify, unpack and install one release: the one sequence the update and rollback routes share.
 * Everything lands in a work dir beside the live tree (same volume, so the swap is a rename) and
 * installPlatformTree switches it in whole or not at all. The work dir is removed on every exit.
 */
async function downloadAndInstall(o: {
  zipUrl: string; manifestUrl: string | undefined; targetVersion: string; currentVersion: string;
  /** The release asset's own size, for re-measuring the volume after a write failure. */
  artifactBytes: number;
}): Promise<{ ok: true; backupDir: string | null } | { ok: false; message: string; status: number }> {
  const kept = `Nothing was changed: Dojo is still running ${o.currentVersion}.`;
  // Disk-space pre-flight before a single byte (the artifact's size is a fact; going back installs no models):
  // refusing leaves no update episode to roll back. Measured again after a write failure, since a disk fills.
  const forward = compareVersions(o.targetVersion, o.currentVersion) > 0;
  const disk = measureUpdateDiskNeed({ artifactBytes: o.artifactBytes, modelBytes: forward ? missingStandardBytes() : 0 });
  const diskRefusal = updateDiskRefusal(disk);
  if (diskRefusal) {
    logger.warn('Install REFUSED before download: not enough free disk', {
      freeBytes: disk.freeBytes, neededBytes: disk.totalNeedBytes, shortfallBytes: disk.shortfallBytes,
      dbBytes: disk.dbBytes, artifactBytes: disk.artifactBytes, platformBytes: disk.platformBytes,
    });
    return { ok: false, message: diskRefusal, status: 507 };
  }
  // Going forward needs the release's checksum list; going back may reach a release from before the lists.
  if (!o.manifestUrl && forward) {
    return { ok: false, message: `${o.targetVersion} was published without its checksum list, so its download could not be checked. ${kept}`, status: 502 };
  }
  // Refuse a second install before downloading anything (the installer re-checks under the lock).
  const probe = acquireSwapLock(DOJO_DIR);
  if (typeof probe !== 'function') return { ok: false, message: `The update could not start: ${probe.busy}. ${kept}`, status: 409 };
  probe();
  const work = newInstallWorkDir(DOJO_DIR);
  try {
    const zipPath = path.join(work, 'dojo-platform.zip');
    await spawnIdleBounded('curl', curlDownloadArgv(o.zipUrl, zipPath), {
      idleMs: UPDATE_DOWNLOAD_IDLE_MS, ceilingMs: UPDATE_DOWNLOAD_CEILING_MS,
    });
    // Integrity before anything is unpacked; only a rollback arrives here without a manifest.
    const verdict = await verifyArtifactAgainstManifest(zipPath, await fetchArtifactManifest(o.manifestUrl));
    if (verdict.outcome === 'refused') return { ok: false, message: `REFUSED — ${verdict.reason}. ${kept}`, status: 502 };

    // No `-q` and no flat total: `unzip -o` prints a line per file and each re-arms the idle bound, so a
    // slow Mac still unpacking is never failed by a clock; the bounded spawner also keeps the output from
    // overflowing a 1 MiB buffer.
    await spawnIdleBounded('unzip', ['-o', zipPath, '-d', work], {
      idleMs: UPDATE_DOWNLOAD_IDLE_MS, ceilingMs: UPDATE_DOWNLOAD_CEILING_MS,
    });
    const staged = path.join(work, 'dojo-platform', 'platform');
    if (!fs.existsSync(path.join(staged, 'package.json'))) {
      return { ok: false, message: `The download does not contain a dojo-platform/platform tree. ${kept}`, status: 500 };
    }
    // A program older than the data's last change would run on data it cannot read: refuse before the marker is touched.
    const steps = path.join(staged, 'packages', 'server', 'dist', 'db', 'migrations');
    if (fs.existsSync(steps) && migrationAheadOfBuild(getDb(), fs.readdirSync(steps))) {
      return { ok: false, message: `${o.targetVersion} cannot read your data: the last change made to it is one ${o.targetVersion} does not have. Choose Roll Back in the menu bar, which puts your data from before the update back too. ${kept}`, status: 409 };
    }
    const r = await installPlatformTree({
      dojoDir: DOJO_DIR, stagedDir: staged, targetVersion: o.targetVersion, previousVersion: o.currentVersion,
      runInstall: (cwd) => runNpmInstall(cwd),
    });
    if (!r.ok) return { ok: false, message: r.message, status: 500 };
    refreshMaintenanceScripts(path.join(work, 'dojo-platform', 'scripts'), path.join(DOJO_DIR, 'scripts'));
    return r;
  } catch (err) {
    const msg = childFailureText(err);
    logger.error('Update download/unpack failed; the live tree was not touched', { error: msg });
    // A write failure that names no cause (curl exit 23) is a disk problem only when the volume
    // is MEASURED short right now (the pre-flight's own measure), never guessed from the code.
    const diskFull = isOutOfSpaceError(err)
      || (isUnnamedWriteFailure(err) && !measureUpdateDiskNeed({ artifactBytes: o.artifactBytes }).ok);
    if (diskFull) return { ok: false, message: `${outOfSpaceFailureMessage(msg)} ${kept}`, status: 507 };
    return { ok: false, message: `The update failed before anything was installed (${msg}). ${kept}`, status: 500 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The maintenance scripts (~/.dojo/scripts: rollback.sh and siblings) live beside platform/ in the package,
 * so the platform swap does not carry them. Each file is replaced by a rename of a complete copy, never
 * truncated in place: a half-written rollback.sh fails exactly when it is needed. Best-effort: never fails
 * an otherwise-good update.
 */
function refreshMaintenanceScripts(src: string, dest: string): void {
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src).filter(n => /\.(sh|md)$/.test(n))) {
      const tmp = path.join(dest, `.${name}.${process.pid}.tmp`);
      fs.copyFileSync(path.join(src, name), tmp);
      if (name.endsWith('.sh')) fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, path.join(dest, name));
    }
    logger.info('Refreshed maintenance scripts from package', { dest });
  } catch (err) {
    logger.warn('Script refresh during update failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * After a successful swap: refresh the bundled watchdog (so the one supervising the new build ships with
 * it), prune old trees (keep 2), flip the record to booting-new and hand the restart to launchd.
 */
async function finishAndRestart(kind: 'update' | 'rollback', from: string, to: string): Promise<void> {
  try {
    const { refreshBundledWatchdog } = await import('../../services/watchdog-refresh.js');
    const r = await refreshBundledWatchdog({ force: true });
    logger.info(`Watchdog refresh after ${kind}`, { refreshed: r.refreshed, reason: r.reason });
  } catch (err) {
    logger.warn(`Watchdog refresh after ${kind} failed (non-fatal)`, { error: err instanceof Error ? err.message : String(err) });
  }
  // Fire-and-forget: the response must not wait on `rm -rf`; the boot prune finishes the job.
  pruneOldBackupsAsync().catch(err => {
    logger.warn(`Backup prune after ${kind} failed (non-fatal)`, { error: err instanceof Error ? err.message : String(err) });
  });
  logger.info(`${kind} complete`, { from, to });
  // The boot sentinel and watchdog take the episode from here.
  markBootingNew();
  setTimeout(() => {
    logger.info(`Restarting server after ${kind}`);
    process.exit(0); // launchd will restart us
  }, 1000);
}

/**
 * Download and install the latest release, then schedule a process restart (launchd brings us back up).
 * Production installs only. Shared by POST /apply and the agent's apply_update tool.
 */
export async function applyUpdate(channel?: UpdateChannel): Promise<ApplyUpdateResult> {
  const ch = channel ?? getUpdateChannel();
  const currentVersion = getCurrentVersion();

  const isProduction = fs.existsSync(PLATFORM_DIR) && fs.existsSync(path.join(PLATFORM_DIR, 'package.json'));
  if (!isProduction) {
    return { ok: false, message: 'Updates are only supported for production installs (~/.dojo/platform). For development, use git pull.', status: 400 };
  }

  try {
    let release: GhRelease | null;
    try {
      release = await resolveLatestRelease(ch);
    } catch (err) {
      return { ok: false, message: `Failed to check GitHub releases: ${childFailureText(err)}`, status: 500 };
    }
    if (!release) {
      return { ok: false, message: `No release found on the ${ch} channel`, status: 500 };
    }
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    if (!zipAsset) {
      return { ok: false, message: 'No dojo-platform.zip found in the target release', status: 500 };
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    // An unreadable installed version cannot support "Already up to date": here proceeding is the safe
    // answer, since the channel's latest repairs a broken install.
    if (!versionIsOrderable(currentVersion)) {
      logger.warn('installing over a box whose own version could not be read', {
        currentVersion, latestVersion, channel: ch,
        why: 'the ordering question has no answer here, and a forward install is the repair',
      });
    } else if (compareVersions(latestVersion, currentVersion) <= 0) {
      return { ok: true, message: 'Already up to date', newVersion: currentVersion };
    }

    logger.info('Starting update', { channel: ch, from: currentVersion, to: latestVersion, url: zipAsset.browser_download_url });
    const installed = await downloadAndInstall({
      zipUrl: zipAsset.browser_download_url,
      manifestUrl: release.assets.find(a => a.name === ARTIFACT_MANIFEST_ASSET)?.browser_download_url,
      targetVersion: latestVersion, currentVersion, artifactBytes: zipAsset.size ?? 0,
    });
    if (!installed.ok) return { ok: false, message: installed.message, status: installed.status };
    await finishAndRestart('update', currentVersion, latestVersion);
    return {
      ok: true,
      message: `Updated from ${currentVersion} to ${latestVersion}. Server is restarting...`,
      previousVersion: currentVersion,
      newVersion: latestVersion,
      backupDir: installed.backupDir ?? undefined,
    };
  } catch (err) {
    const msg = childFailureText(err);
    logger.error('Update failed', { error: msg });
    // A mid-update failure for space says so in plain words: curl, unzip, cp and rsync each report a full
    // disk differently and none of those shapes is a sentence the owner can act on.
    if (isOutOfSpaceError(err)) {
      return { ok: false, message: outOfSpaceFailureMessage(msg), status: 507 };
    }
    return { ok: false, message: `Update failed: ${msg}`, status: 500 };
  }
}

export const updateRouter = new Hono<AppEnv>();


updateRouter.get('/check', async (c) => {
  return c.json({ ok: true, data: await checkForUpdate() });
});


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
  // Refresh the daily cache so the UI and the agent's check_for_update tool agree with the switch.
  const check = await refreshUpdateCache();
  return c.json({ ok: true, data: { channel, check } });
});


updateRouter.get('/version', (c) => c.json({ ok: true, data: { version: getCurrentVersion(), episode: episodeSummary() } }));

// The DATA backup: did the last update leave a way back? Unlike `/backups` (copies of the APP, which restore
// old code and leave the database alone), the pre-migration snapshot is what undoes the migrations' changes
// to the data. It is recorded by db/migration-backup.ts on the boot that ran the chain, so it survives the
// update's restart.
updateRouter.get('/db-backup', (c) => {
  try {
    return c.json({ ok: true, data: { backup: readLastMigrationBackup(getDb()) } });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});


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
      prerelease?: boolean;
      assets: Array<{ name: string; browser_download_url: string; size: number }>;
    }>;

    // Only this release and earlier ones of the box's own channel: a stable box is never offered a pre-release.
    const preflight = getUpdateChannel() === 'preflight';
    const data = releases.filter(r => isValidVersionTag(r.tag_name) && (preflight || !r.prerelease)
      && compareVersions(r.tag_name, currentVersion) <= 0).map(r => {
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


updateRouter.post('/rollback', async (c) => {
  const currentVersion = getCurrentVersion();
  const body = await c.req.json().catch(() => null);
  if (!body?.tag) {
    return c.json({ ok: false, error: 'tag is required (e.g. "v1.12.0")' }, 400);
  }

  const targetTag = (body.tag as string).trim();
  // Shape and ordering gate: nothing is fetched until the target is an earlier version tag.
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
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${targetTag}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return c.json({ ok: false, error: `Release ${targetTag} not found on GitHub (HTTP ${response.status})` }, 404);
    }

    const release = await response.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; size?: number }> };
    const zipAsset = release.assets.find(a => a.name === 'dojo-platform.zip');

    if (!zipAsset) {
      return c.json({ ok: false, error: `No dojo-platform.zip found in release ${targetTag}` }, 500);
    }

    logger.info('Starting rollback', { from: currentVersion, to: targetVersion, url: zipAsset.browser_download_url });
    // The same sequence as an update, and the same marker discipline: a manual rollback is an
    // update episode too (the restored build must come up healthy or the watchdog escalates).
    const installed = await downloadAndInstall({
      zipUrl: zipAsset.browser_download_url,
      manifestUrl: release.assets.find(a => a.name === ARTIFACT_MANIFEST_ASSET)?.browser_download_url,
      targetVersion, currentVersion, artifactBytes: zipAsset.size ?? 0,
    });
    if (!installed.ok) return c.json({ ok: false, error: `Rollback: ${installed.message}` }, installed.status as 500);
    await finishAndRestart('rollback', currentVersion, targetVersion);
    return c.json({
      ok: true,
      data: {
        message: `Rolled back from ${currentVersion} to ${targetVersion}. Server is restarting...`,
        previousVersion: currentVersion,
        newVersion: targetVersion,
        backupDir: installed.backupDir,
      },
    });
  } catch (err) {
    const msg = childFailureText(err);
    logger.error('Rollback failed', { error: msg });
    return c.json({ ok: false, error: `Rollback failed: ${msg}` }, 500);
  }
});


updateRouter.post('/apply', async (c) => {
  const result = await applyUpdate();
  if (!result.ok) {
    return c.json({ ok: false, error: result.message }, (result.status ?? 500) as 400 | 500);
  }
  const { ok: _ok, message, status: _status, ...rest } = result;
  return c.json({ ok: true, data: { message, ...rest } });
});

// Backups: auto-prune runs after every update/rollback (keeps the last 2); this pair lets the user inspect
// and free space on demand. The listing is mtime and name only, so it returns in ms even with hundreds on
// disk.
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

// Cleanup returns 202 at once; `rm -rf` runs in the background (poll /backups/cleanup/status).
updateRouter.post('/backups/cleanup', async (c) => {
  if (cleanupState.inProgress) {
    return c.json({
      ok: false,
      error: 'A cleanup is already in progress. Poll /api/update/backups/cleanup/status for completion.',
    }, 409);
  }

  const body = await c.req.json().catch(() => ({} as { keep?: number }));
  // The newest rollback copy is never cleaned away: a request that would remove it is refused.
  if (typeof body.keep === 'number' && body.keep < 1) {
    return c.json({ ok: false, error: 'The newest rollback copy is always kept, so at least 1 backup must be kept.' }, 400);
  }
  const keep = typeof body.keep === 'number' && body.keep >= 0 ? Math.floor(body.keep) : MAX_BACKUPS_TO_KEEP;

  // Snapshot the target count up front so the dashboard can show progress. The prune deletes all-but-`keep`
  // of BOTH pools (backups and failed builds), so count both or the number under-reports.
  const backupCount = listPlatformBackups().length;
  const failedCount = listFailedBuilds().length;
  const targetCount = backupsToPrune(keep).length;

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

  // Fire-and-forget so Cloudflare's 100s budget is never an issue however long rm -rf takes.
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

// Poll endpoint: the latest cleanup snapshot; inProgress=true means a cleanup is still running.
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
