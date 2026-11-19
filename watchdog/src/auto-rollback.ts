// Watchdog auto-rollback. The watchdog cannot import the platform (it must survive a build that will
// not boot), so the update-state marker shape and reader are kept as a compatible copy of the
// platform's packages/server/src/update-state.ts: KEEP THE TWO IN SYNC. Side-effect free at import.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DOJO_DIR = path.join(os.homedir(), '.dojo');
export const UPDATE_STATE_PATH = path.join(DOJO_DIR, 'update-state.json');
// rollback.sh sits beside ~/.dojo/platform (build-package.sh); the menu-bar uses the same script.
export const ROLLBACK_SCRIPT = path.join(DOJO_DIR, 'scripts', 'rollback.sh');
// rollback.sh --auto writes its outcome here: one line, `<kind><TAB><why>`.
export const ROLLBACK_RESULT_PATH = path.join(DOJO_DIR, 'rollback-result');

export const FAIL_BOOT_ATTEMPTS = 3;
// Wall clock is for the WEDGED-BUT-ALIVE case only (a build that listens but never confirms health; a
// crash loop is caught fast by bootAttempts>=3). 15 min: a heavy migration can hold an episode past health.
export const FAIL_WALL_CLOCK_MS = 15 * 60_000;
export const MAX_AUTO_ROLLBACKS = 1;

export type UpdatePhase =
  | 'idle'
  | 'pending-update'
  | 'booting-new'
  | 'healthy'
  | 'rolled-back'
  | 'failed-permanently'
  // The swap was cut off before it switched anything; the old build is live and whole.
  | 'interrupted';

export interface UpdateMarker {
  phase: UpdatePhase;
  targetVersion: string | null;
  previousVersion: string | null;
  backupDir: string | null;
  stagingDir: string | null;
  bootAttempts: number;
  firstBootAt: string | null;
  lastBootAt: string | null;
  confirmedHealthyAt: string | null;
  rollbackCount: number;
  migrationsRanDuringEpisode: boolean;
  // The data copy from before the episode's first migration; rollback.sh puts it back. SHARED CONTRACT.
  dataBackup: string | null;
  // Why we escalated: the allowed rollback was spent. SHARED CONTRACT.
  failedReason: 'exhausted' | null;
  // Monotonic write counter, the compare-and-swap token: two processes must read-modify-write this
  // file (this daemon writes 'rolled-back' on a box whose platform will not boot), so every RMW goes
  // through updateMarker and a write whose base no longer matches the file is REFUSED. SHARED CONTRACT.
  writeSeq: number;
  updatedAt: string;
}

const PHASES: readonly UpdatePhase[] = [
  'idle', 'pending-update', 'booting-new', 'healthy', 'rolled-back', 'failed-permanently', 'interrupted',
];

// Read mirrors update-state.ts: missing/malformed is null; unknown phase clamps to 'idle'. Never throws.
export function readMarker(statePath: string = UPDATE_STATE_PATH): UpdateMarker | null {
  try {
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
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
      updatedAt: str(parsed.updatedAt) ?? fs.statSync(statePath).mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

// THE SERIALISED WRITE PATH, mirroring packages/server/src/update-state.ts: two processes
// read-modify-write the marker, so a stale read could erase a fact the other just stamped. The lock
// is BEST-EFFORT on purpose: the compare-and-swap makes a stale write harmless.
// The last line of defense must not stall on a lock file somebody died holding.

export const MARKER_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TRIES = 40;
const LOCK_WAIT_MS = 25;

let tmpCounter = 0;
function tempPath(statePath: string): string {
  return `${statePath}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* fall through to the next attempt immediately */
  }
}

function acquireMarkerLock(statePath: string): (() => void) | null {
  const lockPath = `${statePath}.lock`;
  for (let i = 0; i < LOCK_WAIT_TRIES; i++) {
    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(lockPath, 'wx');  // O_CREAT | O_EXCL (atomic)
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > MARKER_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* the lock vanished under us: retry */ }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  return null;
}

// Atomic write (temp + rename), best-effort; the write counter advances here so no caller forgets it.
export function writeMarker(marker: UpdateMarker, statePath: string = UPDATE_STATE_PATH): void {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next: UpdateMarker = { ...marker, writeSeq: (marker.writeSeq ?? 0) + 1, updatedAt: new Date().toISOString() };
    const tmp = tempPath(statePath);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath);
  } catch {
  }
}

// Compare-and-swap: writes `next` ONLY if the file still carries `base`'s counter; else returns false.
export function writeMarkerIfUnchanged(base: UpdateMarker | null, next: UpdateMarker, statePath: string = UPDATE_STATE_PATH): boolean {
  const onDisk = readMarker(statePath);
  if ((onDisk?.writeSeq ?? -1) !== (base?.writeSeq ?? -1)) return false;
  writeMarker(next, statePath);
  return true;
}

// THE ONE DOOR every read-modify-write uses: lock spans read and write; decide on the write-time marker.
export function updateMarker(
  mutate: (current: UpdateMarker | null) => UpdateMarker | null,
  statePath: string = UPDATE_STATE_PATH,
): UpdateMarker | null {
  const release = acquireMarkerLock(statePath);
  try {
    const current = readMarker(statePath);
    const next = mutate(current);
    if (!next) return current;
    if (!writeMarkerIfUnchanged(current, next, statePath)) return readMarker(statePath);
    return readMarker(statePath);
  } catch {
    return readMarker(statePath);
  } finally {
    release?.();
  }
}

export type RollbackDecision =
  | { action: 'none' }
  | { action: 'rollback' }
  | { action: 'escalate'; reason: 'exhausted' };

// PURE gate. Roll back ONLY on a proven failing self-update episode, NEVER on a generic outage; rollback.sh
// decides whether the data goes back too, and says what it did (`RollbackResult`).
export function decideAutoRollback(marker: UpdateMarker | null, nowMs: number): RollbackDecision {
  if (!marker) return { action: 'none' };
  // Only a proven self-update episode is actionable; any other phase is a generic outage: hands off.
  if (marker.phase !== 'booting-new' && marker.phase !== 'rolled-back') return { action: 'none' };
  if (marker.confirmedHealthyAt) return { action: 'none' };

  if (marker.bootAttempts < FAIL_BOOT_ATTEMPTS && !(sinceStartMs(marker, nowMs) >= FAIL_WALL_CLOCK_MS)) return { action: 'none' };

  if (marker.rollbackCount >= MAX_AUTO_ROLLBACKS) return { action: 'escalate', reason: 'exhausted' };
  return { action: 'rollback' };
}

// How long this update has had to start: from its first boot, or, for a build that died before its own code
// ran (no first boot stamped), from when the update was marked. NaN (never in or past the window) if unreadable.
function sinceStartMs(marker: UpdateMarker, nowMs: number): number {
  return nowMs - Date.parse(marker.firstBootAt ?? marker.updatedAt);
}

// An update's first start (the new build, or the restored one after a rollback, which stamps a fresh
// start time) may hold health down: inside FAIL_WALL_CLOCK_MS the restart and the "down" texts wait.
export function updateIsStarting(marker: UpdateMarker | null, nowMs: number): boolean {
  if ((marker?.phase !== 'booting-new' && marker?.phase !== 'rolled-back') || marker.confirmedHealthyAt) return false;
  return sinceStartMs(marker, nowMs) < FAIL_WALL_CLOCK_MS;
}

// The generic "down" texts wait while an update owns the outage: it is still starting, or its failure was
// already texted (that alert stays active until Dojo runs again).
export function updateOwnsOutage(marker: UpdateMarker | null, ledger: Record<string, { active: boolean }>, nowMs: number): boolean {
  return updateIsStarting(marker, nowMs) || !!ledger.auto_rollback_failed?.active;
}

// Written right BEFORE spawning rollback.sh: bump the tally and anchor a FRESH boot window at the
// rollback instant, so a restored build that never executes can still trip the failing gate later
// ('exhausted'). A restored build that does boot keeps this anchor.
export function toRolledBack(marker: UpdateMarker): UpdateMarker {
  const now = new Date().toISOString();
  return {
    ...marker,
    phase: 'rolled-back',
    rollbackCount: marker.rollbackCount + 1,
    bootAttempts: 0,
    firstBootAt: now,
    lastBootAt: null,
    confirmedHealthyAt: null,
    updatedAt: now,
  };
}

// Terminal transition when the one rollback was spent.
export function toFailedPermanently(marker: UpdateMarker, reason: 'exhausted'): UpdateMarker {
  return {
    ...marker,
    phase: 'failed-permanently',
    failedReason: reason,
    updatedAt: new Date().toISOString(),
  };
}

/** What rollback.sh --auto did: the outcome word, and the sentence it wrote for the owner. */
export interface RollbackResult { kind: 'restored-with-data' | 'restored' | 'unchanged' | 'failed'; text: string }

/** The outcome rollback.sh --auto left, or null when there is none. The caller removes it once told. */
export function readRollbackResult(file: string = ROLLBACK_RESULT_PATH): RollbackResult | null {
  try {
    const [kind, text = ''] = fs.readFileSync(file, 'utf-8').trim().split('\t');
    return kind === 'restored-with-data' || kind === 'restored' || kind === 'unchanged' || kind === 'failed' ? { kind, text } : null;
  } catch { return null; }
}

/** The episode after the outcome: neither a refused nor a broken rollback is tried again. */
export function afterRollbackResult(marker: UpdateMarker, r: RollbackResult): UpdateMarker | null {
  if (r.kind === 'restored-with-data' || r.kind === 'restored' || marker.phase === 'failed-permanently') return null;
  return { ...marker, phase: 'failed-permanently', failedReason: null };
}

// Spawn rollback.sh DETACHED (own session, unref'd) so launchd unloading BOTH jobs cannot SIGTERM the
// rollback mid-flight. Returns the pid, or null if it could not spawn; scriptPath is overridable for tests.
export function spawnRollbackDetached(
  scriptPath: string = ROLLBACK_SCRIPT,
  onSpawnError?: (err: Error) => void,
  args: readonly string[] = [],
): number | null {
  // An exec failure arrives on a LATER tick as an 'error' event; with no listener EventEmitter
  // rethrows it as an uncaught exception, outside the try/catch. Attach the listener right after the spawn.
  try {
    if (!fs.existsSync(scriptPath)) return null;
    const child = spawn('/bin/bash', [scriptPath, ...args], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => { onSpawnError?.(err instanceof Error ? err : new Error(String(err))); });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
