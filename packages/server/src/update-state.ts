// Update-state marker: a small JSON file (~/.dojo/update-state.json) recording where a self-update is, so the
// independent watchdog can tell a failing update from an outage and roll it back (rollback.sh also puts back
// `dataBackup` when the data is ahead of the restored build). Not the platform DB: it must be readable when the DB or
// platform will not boot. The watchdog keeps a copy of this shape and reader in watchdog/src/auto-rollback.ts;
// KEEP THE TWO IN SYNC (no shared import across the boundary).

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { homeDir } from './home.js';

const logger = createLogger('update-state');

const DOJO_DIR = path.join(homeDir(), '.dojo');
export const UPDATE_STATE_PATH = path.join(DOJO_DIR, 'update-state.json');

// Failing-boot thresholds, shared with watchdog/src/auto-rollback.ts. bootAttempts catches a crash-exit
// loop; wall-clock catches a wedged-but-alive build.
export const FAIL_BOOT_ATTEMPTS = 3;
// 15 min: firstBootAt is stamped before runMigrations and health-confirm fires ~90s after listen, so a heavy
// migration can hold the episode open for minutes on a slow box.
export const FAIL_WALL_CLOCK_MS = 15 * 60_000;
// At most one auto-rollback per episode; a second failure escalates rather than descending another backup.
export const MAX_AUTO_ROLLBACKS = 1;

export type UpdatePhase =
  | 'idle'
  | 'pending-update'
  | 'booting-new'
  | 'healthy'
  | 'rolled-back'
  | 'failed-permanently'
  | 'interrupted';

export interface UpdateMarker {
  phase: UpdatePhase;
  targetVersion: string | null;
  previousVersion: string | null;
  backupDir: string | null;
  /** the verified staged tree the swap renames into place (null: an in-place updater). */
  stagingDir: string | null;
  bootAttempts: number;
  firstBootAt: string | null;
  lastBootAt: string | null;
  /** ISO, health-confirm stamped this build healthy (stops the failing gate). */
  confirmedHealthyAt: string | null;
  rollbackCount: number;
  migrationsRanDuringEpisode: boolean;
  /** The data copy taken before this episode's first migration committed; set once, never replaced. */
  dataBackup: string | null;
  /** Why the watchdog escalated to 'failed-permanently': the one rollback was spent. Shared with the watchdog. */
  failedReason: 'exhausted' | null;
  /** Compare-and-swap token (see updateMarker); shared with watchdog/src/auto-rollback.ts. */
  writeSeq: number;
  updatedAt: string;
}

const PHASES: readonly UpdatePhase[] = [
  'idle', 'pending-update', 'booting-new', 'healthy', 'rolled-back', 'failed-permanently', 'interrupted',
];

function nowIso(): string {
  return new Date().toISOString();
}

export function emptyMarker(): UpdateMarker {
  return {
    phase: 'idle',
    targetVersion: null,
    previousVersion: null,
    backupDir: null,
    stagingDir: null,
    bootAttempts: 0,
    firstBootAt: null,
    lastBootAt: null,
    confirmedHealthyAt: null,
    rollbackCount: 0,
    migrationsRanDuringEpisode: false,
    dataBackup: null,
    failedReason: null,
    writeSeq: 0,
    updatedAt: nowIso(),
  };
}

// Corrupt-tolerant: a missing or malformed marker reads as null (no episode) and an unknown phase clamps
// to 'idle'. Never throws.
export function readMarker(): UpdateMarker | null {
  try {
    if (!fs.existsSync(UPDATE_STATE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, 'utf-8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const phaseRaw = parsed.phase;
    const phase: UpdatePhase = typeof phaseRaw === 'string' && (PHASES as readonly string[]).includes(phaseRaw)
      ? (phaseRaw as UpdatePhase)
      : 'idle';
    return {
      phase,
      targetVersion: str(parsed.targetVersion),
      previousVersion: str(parsed.previousVersion),
      backupDir: str(parsed.backupDir),
      stagingDir: str(parsed.stagingDir),
      bootAttempts: num(parsed.bootAttempts),
      firstBootAt: str(parsed.firstBootAt),
      lastBootAt: str(parsed.lastBootAt),
      confirmedHealthyAt: str(parsed.confirmedHealthyAt),
      rollbackCount: num(parsed.rollbackCount),
      migrationsRanDuringEpisode: parsed.migrationsRanDuringEpisode === true,
      dataBackup: str(parsed.dataBackup),
      failedReason: parsed.failedReason === 'exhausted' ? 'exhausted' : null,
      writeSeq: num(parsed.writeSeq),
      updatedAt: str(parsed.updatedAt) ?? nowIso(),
    };
  } catch {
    return null;
  }
}

// Serialised write path: lock, read, decide, compare-and-swap. Two processes write this file, and a stale copy
// could erase migrationsRanDuringEpisode and the record of the data copy a rollback puts back.
// Each writer has its own temp file. The lock is best-effort (stale locks are broken; a writer that cannot lock
// still proceeds) because the compare-and-swap makes a stale write harmless and must never be blocked.

const LOCK_PATH = `${UPDATE_STATE_PATH}.lock`;
/** A lock older than this belonged to a dead process. Shared with watchdog/src/auto-rollback.ts. */
export const MARKER_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TRIES = 40;
const LOCK_WAIT_MS = 25;

let tmpCounter = 0;
function tempPath(): string {
  return `${UPDATE_STATE_PATH}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
}

function acquireMarkerLock(): (() => void) | null {
  for (let i = 0; i < LOCK_WAIT_TRIES; i++) {
    try {
      if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
      const fd = fs.openSync(LOCK_PATH, 'wx');  // O_CREAT | O_EXCL: atomic
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } };
    } catch {
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > MARKER_LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;   // retry immediately against the freed lock
        }
      } catch { /* the lock vanished under us: retry */ }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  return null;
}

// Atomic write via temp file + rename; never throws into the boot/update path. Advances the write counter.
export function writeMarker(marker: UpdateMarker): void {
  try {
    if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
    const next: UpdateMarker = { ...marker, writeSeq: (marker.writeSeq ?? 0) + 1, updatedAt: nowIso() };
    const tmp = tempPath();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, UPDATE_STATE_PATH);
  } catch (err) {
    logger.warn('Failed to persist update-state marker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Compare-and-swap: writes `next` only if the file still carries `base`'s write counter. */
export function writeMarkerIfUnchanged(base: UpdateMarker | null, next: UpdateMarker): boolean {
  const onDisk = readMarker();
  if ((onDisk?.writeSeq ?? -1) !== (base?.writeSeq ?? -1)) return false;
  writeMarker(next);
  return true;
}

// The one door for every read-modify-write: holds the lock across read and write; a null from `mutate`
// writes nothing. Returns the marker as it stands afterwards (after a refused CAS, the newer one).
export function updateMarker(mutate: (current: UpdateMarker | null) => UpdateMarker | null): UpdateMarker | null {
  const release = acquireMarkerLock();
  try {
    const current = readMarker();
    const next = mutate(current);
    if (!next) return current;
    if (!writeMarkerIfUnchanged(current, next)) {
      logger.warn('update-state: refused a write built on a stale marker (another writer moved it first)');
      return readMarker();
    }
    return readMarker();
  } catch (err) {
    logger.warn('update-state: marker update failed', { error: err instanceof Error ? err.message : String(err) });
    return readMarker();
  } finally {
    release?.();
  }
}

// Writer helpers: each marks one phase of the episode.

// The installer (update/install-tree.ts): written right before the two renames; opens a fresh episode.
export function markPendingUpdate(args: { targetVersion: string; previousVersion: string; backupDir: string; stagingDir: string }): void {
  // A new episode resets every field except writeSeq: rewinding it would let a straggling write pass the CAS.
  updateMarker((prev) => ({
    ...emptyMarker(),
    phase: 'pending-update',
    targetVersion: args.targetVersion,
    previousVersion: args.previousVersion,
    backupDir: args.backupDir,
    stagingDir: args.stagingDir,
    writeSeq: prev?.writeSeq ?? 0,
  }));
}

// applyUpdate / rollback seam: call right before the scheduled process.exit(0) that hands off to launchd.
export function markBootingNew(): void {
  updateMarker((m) => ({
    ...(m ?? emptyMarker()),
    phase: 'booting-new',
    bootAttempts: 0,
    firstBootAt: null,
    lastBootAt: null,
    confirmedHealthyAt: null,
  }));
}

// Boot sentinel (index.ts, before runMigrations): counts this start if a boot episode is in flight.
// Returns the updated marker, or null on a normal boot.
export function recordBootAttempt(): UpdateMarker | null {
  let acted = false;
  const after = updateMarker((m) => {
    if (!m) return null;
    if (m.phase !== 'booting-new' && m.phase !== 'rolled-back') return null;
    acted = true;
    const now = nowIso();
    return { ...m, bootAttempts: m.bootAttempts + 1, firstBootAt: m.firstBootAt ?? now, lastBootAt: now };
  });
  return acted ? after : null;
}

// Synthetic episode for a boot with no marker: an older in-app updater swaps the tree without writing one,
// yet the boot carries pending migrations. The watchdog refresh (services/watchdog-refresh.ts) needs a
// 'booting-new' phase to hold its restart across that window. Call only when no marker exists.
export function synthesizeMigrationBootEpisode(targetVersion: string | null): void {
  const now = nowIso();
  updateMarker((prev) => ({
    ...emptyMarker(),
    phase: 'booting-new',
    targetVersion,
    bootAttempts: 1,
    firstBootAt: now,
    lastBootAt: now,
    writeSeq: prev?.writeSeq ?? 0,
  }));
}

// The runner, when an episode's first migration commits: the data is now ahead of the build it replaced, and
// `dataBackup` is the copy from before. Set once per episode, so a crash loop never replaces it.
export function markMigrationsRan(dataBackup: string | null): void {
  updateMarker((m) => {
    if (!m) return null;
    if (m.phase !== 'booting-new' && m.phase !== 'rolled-back') return null;
    if (m.migrationsRanDuringEpisode) return null;
    return { ...m, migrationsRanDuringEpisode: true, dataBackup };
  });
}

// Health-confirm (index.ts, ~90s after server.listen). A new build ends 'healthy'; a restored build stays
// 'rolled-back' as the durable record, and confirmedHealthyAt stops the watchdog treating it as failing.
export function confirmHealthy(): boolean {
  let acted = false;
  updateMarker((m) => {
    if (!m || (m.phase !== 'booting-new' && m.phase !== 'rolled-back') || m.confirmedHealthyAt) return null;
    acted = true;
    return { ...m, phase: m.phase === 'booting-new' ? 'healthy' : 'rolled-back', confirmedHealthyAt: nowIso() };
  });
  return acted;
}
