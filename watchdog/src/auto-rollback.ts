// ════════════════════════════════════════
// Watchdog auto-rollback (D-F)
//
// The watchdog is an INDEPENDENT package: it must survive a build that will not
// boot, so it cannot import from the platform (@dojo/shared or packages/server).
// This file therefore keeps a byte-for-byte-compatible copy of the update-state
// marker shape + reader that the platform OWNS in
// packages/server/src/update-state.ts. KEEP THE TWO IN SYNC: the only thing
// binding them is this documented contract.
//
// Everything here is side-effect free at import so the decision gate can be
// unit-driven against a scratch marker + injected clock, no real crash loop.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DOJO_DIR = path.join(os.homedir(), '.dojo');
export const UPDATE_STATE_PATH = path.join(DOJO_DIR, 'update-state.json');
// rollback.sh is installed as a sibling of ~/.dojo/platform (see update.ts step
// 6b + build-package.sh). The menu-bar manual rollback shells the same script.
export const ROLLBACK_SCRIPT = path.join(DOJO_DIR, 'scripts', 'rollback.sh');

// SHARED CONTRACT with packages/server/src/update-state.ts.
export const FAIL_BOOT_ATTEMPTS = 3;
// Wall clock is for the WEDGED-BUT-ALIVE case only (a build that listens but
// never confirms health); a crash-exit loop is still caught fast by
// bootAttempts>=3. Set to 15 min because firstBootAt is stamped BEFORE
// runMigrations and the health-confirm fires ~90s AFTER listen, so a one-time
// heavy migration can legitimately hold the episode open for several minutes on
// a slow box while the build is about to become healthy. A 5-minute clock tripped
// a false "update failed" escalation in that window; 15 min clears it.
export const FAIL_WALL_CLOCK_MS = 15 * 60_000;
export const MAX_AUTO_ROLLBACKS = 1;

export type UpdatePhase =
  | 'idle'
  | 'pending-update'
  | 'booting-new'
  | 'healthy'
  | 'rolled-back'
  | 'failed-permanently';

export interface UpdateMarker {
  phase: UpdatePhase;
  targetVersion: string | null;
  previousVersion: string | null;
  backupDir: string | null;
  bootAttempts: number;
  firstBootAt: string | null;
  lastBootAt: string | null;
  confirmedHealthyAt: string | null;
  rollbackCount: number;
  migrationsRanDuringEpisode: boolean;
  // Why we escalated to 'failed-permanently' ('migration' = a migration ran, so a
  // code-only rollback is unsafe; 'exhausted' = the one allowed rollback was spent).
  // null in every non-terminal state. SHARED CONTRACT with the platform's
  // packages/server/src/update-state.ts: the platform's confirmHealthy reads this so
  // ONLY a migration escalation may later self-recover if the box comes up healthy.
  failedReason: 'migration' | 'exhausted' | null;
  updatedAt: string;
}

const PHASES: readonly UpdatePhase[] = [
  'idle', 'pending-update', 'booting-new', 'healthy', 'rolled-back', 'failed-permanently',
];

// Corrupt-tolerant read (mirrors update-state.ts). A missing or malformed marker
// reads as null; an unknown phase clamps to 'idle'. Never throws. The optional
// statePath keeps this testable against a scratch HOME.
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
      bootAttempts: num(parsed.bootAttempts),
      firstBootAt: str(parsed.firstBootAt),
      lastBootAt: str(parsed.lastBootAt),
      confirmedHealthyAt: str(parsed.confirmedHealthyAt),
      rollbackCount: num(parsed.rollbackCount),
      migrationsRanDuringEpisode: parsed.migrationsRanDuringEpisode === true,
      failedReason: parsed.failedReason === 'migration' || parsed.failedReason === 'exhausted' ? parsed.failedReason : null,
      updatedAt: str(parsed.updatedAt) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// Atomic write (temp + rename). Best-effort: never throws into the check cycle.
export function writeMarker(marker: UpdateMarker, statePath: string = UPDATE_STATE_PATH): void {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next: UpdateMarker = { ...marker, updatedAt: new Date().toISOString() };
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath);
  } catch {
    // Best-effort: a failed persist must never throw into the check cycle.
  }
}

export type RollbackDecision =
  | { action: 'none' }
  | { action: 'rollback' }
  | { action: 'escalate'; reason: 'migration' | 'exhausted' };

// PURE gate (the plan's testable-without-a-crash-loop decision function). Roll
// back ONLY when the marker proves a self-update is in-flight-and-failing; NEVER
// on a generic outage. Owner decision 2026-07-06: if the failed build changed
// the DB, escalate (loud) instead of a code-only rollback that could brick the
// box on a schema the old build does not understand.
export function decideAutoRollback(marker: UpdateMarker | null, nowMs: number): RollbackDecision {
  if (!marker) return { action: 'none' };
  // Only a proven self-update episode is actionable (in-flight or a restored
  // build we are still watching). Any other phase is a generic outage: hands off.
  if (marker.phase !== 'booting-new' && marker.phase !== 'rolled-back') return { action: 'none' };
  // The current build already confirmed itself healthy; nothing is failing.
  if (marker.confirmedHealthyAt) return { action: 'none' };

  const attempts = marker.bootAttempts;
  const firstBootMs = marker.firstBootAt ? Date.parse(marker.firstBootAt) : NaN;
  const wallClockExceeded = Number.isFinite(firstBootMs) && (nowMs - firstBootMs) >= FAIL_WALL_CLOCK_MS;
  const failing = attempts >= FAIL_BOOT_ATTEMPTS || wallClockExceeded;
  if (!failing) return { action: 'none' };

  // A failing self-update is in flight.
  if (marker.migrationsRanDuringEpisode) return { action: 'escalate', reason: 'migration' };
  if (marker.rollbackCount >= MAX_AUTO_ROLLBACKS) return { action: 'escalate', reason: 'exhausted' };
  return { action: 'rollback' };
}

// Marker transition the watchdog writes right BEFORE it spawns rollback.sh: bump
// the rollback tally and open a FRESH boot window for the restored build so the
// SAME failing gate can catch a restored build that also will not boot (which
// then escalates, never a second rollback). Also stops a duplicate cycle from
// spawning twice (rollbackCount is now at the bound).
//
// ── THE ANCHOR IS SET, NOT CLEARED (SWEEP CORE-2 item 6) ──
// This used to write `firstBootAt: null`, which left the fresh window with NO
// clock to measure from. The failing gate reads two things: the boot-attempt
// counter (stamped by the platform's boot sentinel) and the wall clock (measured
// from `firstBootAt`). If the restored build cannot execute AT ALL — a truncated
// backup, a half-finished restore, a launchd job that never comes back — nothing
// ever reaches the sentinel, so `bootAttempts` stays 0 AND the anchor stays null,
// `decideAutoRollback` answers 'none' for ever, and the update episode NEVER
// escalates. The box is down and the D-F machinery is silent about the update
// that took it down. Anchoring the fresh window at the ROLLBACK INSTANT keeps the
// restored build's grace period intact (nothing is failing for the next 15
// minutes) while guaranteeing the gate can still trip afterwards: with
// `rollbackCount` now at the bound, that trip is 'exhausted' — the honest verdict
// that the one allowed rollback was spent and did not work.
//
// `recordBootAttempt`'s `firstBootAt ?? now` means a restored build that DOES
// boot keeps this anchor rather than restarting the clock, which is deliberate:
// a restored build is OLD code and runs no new migrations, so it has no claim on
// the migration allowance the 15 minutes was sized for.
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

// Terminal transition when we will NOT auto-roll-back (a migration ran, or the
// one allowed rollback was already spent). launchd still relaunches whatever
// build is in place; the owner gets the loud alert + a Healer diagnostic. The
// escalation reason is persisted so the platform's confirmHealthy can tell a
// recoverable migration escalation (the build may still finish healthy after the
// window) from an unrecoverable exhausted one (a spent rollback that also failed).
export function toFailedPermanently(marker: UpdateMarker, reason: 'migration' | 'exhausted'): UpdateMarker {
  return {
    ...marker,
    phase: 'failed-permanently',
    failedReason: reason,
    updatedAt: new Date().toISOString(),
  };
}

// Spawn rollback.sh DETACHED (own session, unref'd) so launchd unloading BOTH
// the platform AND the watchdog jobs (rollback.sh does exactly that) cannot
// SIGTERM the rollback mid-flight. Returns the child pid, or null if it could
// not spawn (missing script / exec error). The scriptPath override keeps this
// testable against a fake script under a scratch HOME.
export function spawnRollbackDetached(scriptPath: string = ROLLBACK_SCRIPT): number | null {
  try {
    if (!fs.existsSync(scriptPath)) return null;
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
