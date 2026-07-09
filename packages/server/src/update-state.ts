// ════════════════════════════════════════
// Update-state marker (D-F auto-rollback)
//
// A tiny JSON file at ~/.dojo/update-state.json that records where we are in a
// self-update episode, so the INDEPENDENT watchdog can tell a FAILING self-update
// apart from a generic outage and safely auto-roll-back CODE ONLY (owner decision
// 2026-07-06, OPTION A: rollback restores code only; if the failed build ran ANY
// migration, escalate loudly instead of trusting a code-only rollback).
//
// This is deliberately NOT the platform DB: it must be readable/writable even
// when the DB, or the whole platform, will not boot, and it is the ONE piece of
// state the watchdog (a separate package that cannot import from the platform)
// also reads. The watchdog keeps a byte-for-byte-compatible copy of this shape +
// reader in watchdog/src/auto-rollback.ts. KEEP THE TWO IN SYNC: there is no
// shared import across the independence boundary, only this documented contract.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from './logger.js';

const logger = createLogger('update-state');

const DOJO_DIR = path.join(os.homedir(), '.dojo');
export const UPDATE_STATE_PATH = path.join(DOJO_DIR, 'update-state.json');

// Failing-boot thresholds. SHARED CONTRACT with watchdog/src/auto-rollback.ts.
// bootAttempts catches a crash-exit loop; wall-clock catches a wedged-but-alive
// build. Either one, while still inside the episode, means "the new build did
// not come up healthy".
export const FAIL_BOOT_ATTEMPTS = 3;
// Wall clock is for the WEDGED-BUT-ALIVE case only; a crash-exit loop is caught
// fast by bootAttempts>=3. 15 min because firstBootAt is stamped BEFORE
// runMigrations and the health-confirm fires ~90s AFTER listen, so a one-time
// heavy migration can hold the episode open for minutes on a slow box while the
// build is about to be healthy. A 5-minute clock tripped a false escalation there.
export const FAIL_WALL_CLOCK_MS = 15 * 60_000;
// At most ONE auto-rollback per episode. If the restored build also fails we
// escalate loudly rather than descend a second backup (old code vs newer schema).
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
  /** Version we are updating TO (the build being booted). */
  targetVersion: string | null;
  /** Version we updated FROM (the rollback target). */
  previousVersion: string | null;
  /** Absolute path of the backup made right before the swap. */
  backupDir: string | null;
  /** Times the boot sentinel has seen this episode's build start. */
  bootAttempts: number;
  /** ISO, first sentinel observation of this build (wall-clock anchor). */
  firstBootAt: string | null;
  /** ISO, most recent sentinel observation. */
  lastBootAt: string | null;
  /** ISO, health-confirm stamped this build healthy (stops the failing gate). */
  confirmedHealthyAt: string | null;
  /** Auto-rollbacks performed this episode (bound = MAX_AUTO_ROLLBACKS). */
  rollbackCount: number;
  /** A migration applied while phase was booting-new/rolled-back (escalation trigger). */
  migrationsRanDuringEpisode: boolean;
  /**
   * Why the watchdog escalated to 'failed-permanently' ('migration' = a migration
   * ran so a code-only rollback is unsafe; 'exhausted' = the one allowed rollback
   * was already spent). null in every non-terminal state. SHARED CONTRACT with
   * watchdog/src/auto-rollback.ts: the watchdog writes it, confirmHealthy reads it
   * so ONLY a migration-escalation may later self-recover (see confirmHealthy).
   */
  failedReason: 'migration' | 'exhausted' | null;
  /** ISO, last write. */
  updatedAt: string;
}

const PHASES: readonly UpdatePhase[] = [
  'idle', 'pending-update', 'booting-new', 'healthy', 'rolled-back', 'failed-permanently',
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
    bootAttempts: 0,
    firstBootAt: null,
    lastBootAt: null,
    confirmedHealthyAt: null,
    rollbackCount: 0,
    migrationsRanDuringEpisode: false,
    failedReason: null,
    updatedAt: nowIso(),
  };
}

// Corrupt-tolerant read: a missing OR malformed marker reads as null, and the
// caller treats null as "no episode in flight". Never throws. Unknown phases
// clamp to 'idle' so a hand-edited or half-written file can never crash boot.
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
    // Absent/unknown reason clamps to null (an older marker predates the field).
    const failedReason: 'migration' | 'exhausted' | null =
      parsed.failedReason === 'migration' || parsed.failedReason === 'exhausted' ? parsed.failedReason : null;
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
      failedReason,
      updatedAt: str(parsed.updatedAt) ?? nowIso(),
    };
  } catch {
    return null;
  }
}

// Atomic write: temp file + rename (rename is atomic on POSIX, so a crash
// mid-write leaves either the old file or the new one, never a half file).
// Best-effort: a persist failure must NEVER throw into the boot/update path.
export function writeMarker(marker: UpdateMarker): void {
  try {
    if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
    const next: UpdateMarker = { ...marker, updatedAt: nowIso() };
    const tmp = `${UPDATE_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, UPDATE_STATE_PATH);
  } catch (err) {
    logger.warn('Failed to persist update-state marker', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Writer helpers (who writes which phase, when) ──

// applyUpdate / rollback seam (gateway/routes/update.ts): call right AFTER the
// pre-swap backup exists. Opens a fresh episode.
export function markPendingUpdate(args: { targetVersion: string; previousVersion: string; backupDir: string }): void {
  writeMarker({
    ...emptyMarker(),
    phase: 'pending-update',
    targetVersion: args.targetVersion,
    previousVersion: args.previousVersion,
    backupDir: args.backupDir,
  });
}

// applyUpdate / rollback seam: call right BEFORE the scheduled process.exit(0)
// that hands off to launchd. The NEW process boots and the sentinel increments.
export function markBootingNew(): void {
  const m = readMarker() ?? emptyMarker();
  writeMarker({
    ...m,
    phase: 'booting-new',
    bootAttempts: 0,
    firstBootAt: null,
    lastBootAt: null,
    confirmedHealthyAt: null,
  });
}

// Boot sentinel (index.ts, BEFORE runMigrations). If a self-update boot episode
// is in flight, count this start. Returns the updated marker (so the caller can
// decide whether to watch migrations), or null on a normal (non-update) boot.
export function recordBootAttempt(): UpdateMarker | null {
  const m = readMarker();
  if (!m) return null;
  if (m.phase !== 'booting-new' && m.phase !== 'rolled-back') return null;
  const now = nowIso();
  const next: UpdateMarker = {
    ...m,
    bootAttempts: m.bootAttempts + 1,
    firstBootAt: m.firstBootAt ?? now,
    lastBootAt: now,
  };
  writeMarker(next);
  return next;
}

// Jump-#1 synthetic episode. An OLD in-app updater (one that predates the D-F
// marker) can swap ~/.dojo/platform WITHOUT writing an update-state marker, so on
// the very first jump to a marker-aware build recordBootAttempt finds nothing even
// though this boot is a genuine self-update carrying a long chain of new
// migrations. The freshly self-installed patient watchdog (services/watchdog-
// refresh.ts, run before migrations) needs a 'booting-new' phase to read to hold
// its restart across that migration window. Create one here.
//
// migrationsRanDuringEpisode is set TRUE up front on purpose: a synthetic episode
// has no backupDir/previousVersion (the old updater recorded none), so if it ever
// goes failing the watchdog MUST escalate loudly (owner alert) rather than try a
// code-only rollback with no backup to restore. The caller only ever invokes this
// when NO real marker exists AND pending migrations were detected on an ALREADY-
// migrated box, so it can never fire on a fresh install (that box has 0 applied
// migrations) or a normal restart (no pending migrations).
export function synthesizeMigrationBootEpisode(targetVersion: string | null): UpdateMarker {
  const now = nowIso();
  const marker: UpdateMarker = {
    ...emptyMarker(),
    phase: 'booting-new',
    targetVersion,
    previousVersion: null,
    backupDir: null,
    bootAttempts: 1,
    firstBootAt: now,
    lastBootAt: now,
    migrationsRanDuringEpisode: true,
    failedReason: null,
  };
  writeMarker(marker);
  return marker;
}

// Boot sentinel follow-up (index.ts, right AFTER runMigrations) when a migration
// applied during a boot episode. Owner decision 2026-07-06: if the failed build
// changed the database, we must NOT trust a code-only rollback; the watchdog
// escalates loudly instead.
export function markMigrationsRan(): void {
  const m = readMarker();
  if (!m) return;
  if (m.phase !== 'booting-new' && m.phase !== 'rolled-back') return;
  if (m.migrationsRanDuringEpisode) return;
  writeMarker({ ...m, migrationsRanDuringEpisode: true });
}

// Health-confirm (index.ts, ~90s after server.listen). The booting build proved
// itself healthy. A NEW build ending healthy closes the episode as 'healthy'; a
// RESTORED build (phase 'rolled-back') stays 'rolled-back' as the durable record
// that an auto-rollback happened, but confirmedHealthyAt is what stops the
// watchdog treating the now-stable box as still-failing. Returns whether it
// acted (false on a normal boot or an already-confirmed marker).
export function confirmHealthy(): boolean {
  const m = readMarker();
  if (!m) return false;

  // In-flight confirmation (the common path): a build that is still coming up.
  if (m.phase === 'booting-new' || m.phase === 'rolled-back') {
    if (m.confirmedHealthyAt) return false;
    writeMarker({
      ...m,
      phase: m.phase === 'booting-new' ? 'healthy' : 'rolled-back',
      confirmedHealthyAt: nowIso(),
    });
    return true;
  }

  // FALSE-ESCALATION RECOVERY. A migration-carrying self-update can legitimately
  // finish AFTER the watchdog's 15-min wall-clock (FAIL_WALL_CLOCK_MS): by then
  // the watchdog has already escalated to 'failed-permanently' (reason 'migration')
  // and texted the owner. When THIS build then confirms itself genuinely healthy
  // (the caller has already re-checked the DB is serving), clear that FALSE
  // terminal state so the box is not stranded with a zombie 'failed-permanently'
  // marker and an uncorrected owner alert. The watchdog emits the owner-facing "it
  // finished after all" correction on its OWN alert path the next time it sees the
  // box healthy (it resolves the auto_rollback_failed alert it raised).
  //
  // ONLY the migration reason may recover. An 'exhausted' escalation (a code-only
  // rollback was already spent and the restored build ALSO failed) or any other
  // terminal state must NEVER self-bless: that would let a genuinely half-rolled-
  // back box paper over its own failure. Preserve that refusal.
  if (m.phase === 'failed-permanently' && m.failedReason === 'migration' && !m.confirmedHealthyAt) {
    writeMarker({
      ...m,
      phase: 'healthy',
      confirmedHealthyAt: nowIso(),
    });
    logger.info('D-F: a migration-escalated self-update confirmed healthy after the watchdog window; cleared the false failed-permanently state (watchdog will send the owner correction)');
    return true;
  }

  return false;
}
