// Dojo Watchdog: standalone process monitors platform health independently.

import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  readMarker,
  updateMarker,
  decideAutoRollback,
  toRolledBack,
  toFailedPermanently,
  spawnRollbackDetached,
  readRollbackResult,
  ROLLBACK_RESULT_PATH,
  afterRollbackResult,
  ROLLBACK_SCRIPT,
  updateIsStarting,
  type RollbackDecision,
  type UpdateMarker,
} from './auto-rollback.js';
import {
  emptyState,
  readState,
  persistState,
  integrityFailureFromError,
  markAlertResolved as markAlertResolvedIn,
  sendAlert,
  sendRecovery,
  readLevel,
  tellBack,
  outageTexts,
  integrityDue,
  tellRollbackOutcome,
  type WatchdogState, type AlertKey,
} from './alert-ledger.js';
import { diskFloorBytes, toGb } from './disk-floor.js';
import { decideSwapHeal, interruptedUpdateText, claimInterruptedNotice } from './swap-heal.js';
import { chooseOwnerRecipient, type ApprovedSender } from './owner-recipient.js';


const PLATFORM_URL = process.env.DOJO_URL ?? 'http://localhost:3001';
const HEALTH_ENDPOINT = `${PLATFORM_URL}/api/health`;
const CHECK_INTERVAL_MS = 120_000; // 2 minutes
const DB_PATH = path.join(os.homedir(), '.dojo', 'data', 'dojo.db');
const LOG_PATH = path.join(os.homedir(), '.dojo', 'logs', 'watchdog.log');
const DOJO_DIR = path.join(os.homedir(), '.dojo');

// Watchdog-owned state store: heartbeat, last alert, and the alert ledger live in a JSON file the
// watchdog alone owns, read-only on the platform DB; survives restart; the route reads it.
const STATE_PATH = path.join(DOJO_DIR, 'watchdog-state.json');

// Last-known-good recipient cache: fall back to the last validated approved recipient ONLY when a
// live read FAILS; a successful read that approves nobody clears the cache, so a deliberate removal wins.
const RECIPIENT_CACHE_PATH = path.join(DOJO_DIR, 'watchdog-recipient.json');

let cachedRecipient: string | null = null;
let recipientCacheLoaded = false;

function loadRecipientCache(): void {
  recipientCacheLoaded = true;
  try {
    if (!fs.existsSync(RECIPIENT_CACHE_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(RECIPIENT_CACHE_PATH, 'utf-8')) as { address?: unknown };
    if (parsed && typeof parsed.address === 'string' && parsed.address) {
      cachedRecipient = parsed.address;
    }
  } catch {
    // Best-effort: a missing or corrupt cache file simply means no last-known-good.
  }
}

// Lazily loaded: the first read may fail before memory holds anything.
function getCachedRecipient(): string {
  if (!recipientCacheLoaded) loadRecipientCache();
  return cachedRecipient ?? '';
}

function cacheRecipient(address: string): void {
  if (!address) return;
  cachedRecipient = address;
  recipientCacheLoaded = true;
  // Best-effort file write: this must NEVER throw into the check cycle.
  try {
    if (!fs.existsSync(DOJO_DIR)) fs.mkdirSync(DOJO_DIR, { recursive: true });
    fs.writeFileSync(RECIPIENT_CACHE_PATH, JSON.stringify({ address, writtenAt: new Date().toISOString() }));
  } catch {
    // Memory cache still holds for this process; the file is a bonus for cold starts.
  }
}

function clearCachedRecipient(): void {
  cachedRecipient = null;
  recipientCacheLoaded = true;
  try {
    if (fs.existsSync(RECIPIENT_CACHE_PATH)) fs.unlinkSync(RECIPIENT_CACHE_PATH);
  } catch {
  }
}

// Never text an UNAPPROVED number: this runs out-of-band, so it validates here against the same
// `imessage_approved_senders` config the bridge uses: candidate if approved, else primary, else ''.

// A read FAILURE (DB unreadable) is not a successful empty allowlist: only it may use last-known-good.
type ApprovedSendersRead = { ok: true; senders: ApprovedSender[] } | { ok: false };

function getApprovedSenders(): ApprovedSendersRead {
  // DB missing is a FAILURE (not "approves nobody"): never mute the watchdog when a fallback is on file.
  if (!fs.existsSync(DB_PATH)) return { ok: false };
  let value: string | undefined;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    // Read-only, plus busy_timeout so a transient platform-DB lock is waited out, not thrown.
    db.pragma('busy_timeout = 3000');
    const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string } | undefined;
    db.close();
    value = row?.value;
  } catch {
    return { ok: false }; // DB locked / corrupted / query threw = read FAILED
  }
  // Read succeeded from here down. No configured value = owner approves nobody.
  if (!value) return { ok: true, senders: [] };
  try {
    const parsed = JSON.parse(value);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.senders) ? parsed.senders : []);
    const senders = arr
      // A bare-address list: the first entry is the owner.
      .map((s: unknown, i: number) => (typeof s === 'string' ? { address: s, is_primary: i === 0 } : (s as ApprovedSender)))
      .filter((s: { address?: string }) => !!s.address) as ApprovedSender[];
    return { ok: true, senders };
  } catch {
    return { ok: false }; // corrupted config value = treat as read FAILED
  }
}

// iMessage recipient validated against the allowlist; last-known-good fallback if the DB read fails.
function getImessageRecipient(): string {
  const read = getApprovedSenders();

  // Live read FAILED: use the last validated recipient so a corrupted-DB alert still reaches the owner.
  if (!read.ok) {
    const cached = getCachedRecipient();
    if (cached) {
      log('warn', 'recipient resolved from last-known-good cache, DB unreadable');
      return cached;
    }
    return '';
  }

  const approved = read.senders;
  // Successful read, empty allowlist = the owner approves nobody: send nothing AND clear the cache.
  if (approved.length === 0) {
    clearCachedRecipient();
    return '';
  }

  // Honor the candidate only if it is approved; else the approved primary (the owner), else nothing.
  const candidate = process.env.DOJO_IMESSAGE_RECIPIENT
    ?? (() => {
      try {
        if (!fs.existsSync(DB_PATH)) return '';
        const db = new Database(DB_PATH, { readonly: true });
        db.pragma('busy_timeout = 3000');
        const row = db.prepare("SELECT value FROM config WHERE key = 'imessage_default_sender'").get() as { value: string } | undefined;
        db.close();
        return row?.value ?? '';
      } catch { return ''; }
    })();
  const resolved = chooseOwnerRecipient(approved, candidate);
  if (!resolved) {
    // No starred owner (the owner removed it on purpose): text nobody, and keep no stale recipient.
    clearCachedRecipient();
    log('warn', 'no owner is starred on the iMessage list; the watchdog will not text anyone');
    return '';
  }

  // Refresh the cache on every successful resolution; it only ever holds a validated address.
  cacheRecipient(resolved);
  return resolved;
}

let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_RESTART = 5;

// Truthful downtime accounting: `consecutiveFailures` resets ONLY on recovery, so the DOWN alert
// counts real downtime across restarts; a separate `failuresSinceRestart` drives the restart cadence
// (the only thing a restart resets); `restartAttempts` / `lastRestartAt` gate the "restart failed" alert.
let failuresSinceRestart = 0;
let restartAttempts = 0;
let lastRestartAt = 0;

// The ledger lives in `alert-ledger.ts` so it can be unit-driven (this file starts a daemon at import).
// Rules: first sends, a still-active issue waits 2 hours, a resolution sends exactly one recovery.
let state: WatchdogState = emptyState();

function loadState(): void {
  state = readState(STATE_PATH);
}

function saveState(): void {
  if (!persistState(state, STATE_PATH)) {
    log('error', 'Failed to persist watchdog state', { path: STATE_PATH });
  }
}

function markAlertResolved(alertKey: string): boolean {
  const resolved = markAlertResolvedIn(state, alertKey);
  if (resolved) saveState();
  return resolved;
}

// Checks in a row on each side of a level's line (memory, disk); see readLevel.
const levelRuns: Record<string, number> = {};

/** Text the owner about an alert, once per cooldown; true when it went out. */
function alert(alertKey: AlertKey, text: string, record: string): boolean {
  if (!sendAlert(state, alertKey, getImessageRecipient(), text, sendIMessage)) return false;
  recordAlert(record);
  return true;
}

/** Tell the owner an alert is over; it stays active until the text went out. */
function resolveAndTell(alertKey: AlertKey, text: string): boolean {
  if (!sendRecovery(state, alertKey, getImessageRecipient(), text, sendIMessage)) return false;
  saveState();
  return true;
}


function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(level: string, message: string, meta?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'watchdog',
    message,
    ...(meta ? { meta } : {}),
  });
  // Best-effort: a full disk or unwritable ~/.dojo must never kill the daemon. Only a line the
  // rotated file could not take goes to launchd's stderr file, so that file stays small.
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, entry + '\n');
  } catch {
    console.error(entry);
  }
}


function sendIMessage(recipient: string, text: string): boolean {
  if (!recipient) {
    log('warn', 'No iMessage recipient configured');
    return false;
  }

  try {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Positional `1st service whose service type = iMessage` throws AppleScript -10002 on recent
    // macOS; iterate services by element (no filtered "whose" reference), fall back to `item 1`.
    const script = `
      tell application "Messages"
        set targetService to missing value
        repeat with s in services
          try
            if (service type of s) is iMessage then
              set targetService to s
              exit repeat
            end if
          end try
        end repeat
        if targetService is missing value then set targetService to item 1 of services
        set targetBuddy to buddy "${escapedRecipient}" of targetService
        send "${escapedText}" to targetBuddy
      end tell
    `;

    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      timeout: 10000,
      encoding: 'utf-8',
    });

    log('info', 'iMessage sent', { recipient, textLength: text.length });
    return true;
  } catch (err) {
    log('error', 'Failed to send iMessage', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Heartbeat and last-alert go to the watchdog's OWN store, never the platform DB; the route reads it.

function recordHeartbeat(): void {
  state.lastHeartbeat = new Date().toISOString();
  saveState();
}

function recordAlert(message: string): void {
  state.lastAlert = { message, at: new Date().toISOString() };
  saveState();
}


async function checkPlatformHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      log('warn', 'Platform health check failed', { status: response.status });
      return false;
    }

    const data = await response.json() as { ok: boolean; data?: { db: string } };
    if (!data.ok || data.data?.db === 'error') {
      log('warn', 'Platform unhealthy', { data });
      return false;
    }

    return true;
  } catch (err) {
    log('error', 'Platform unreachable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function getMacAvailableMemoryMb(): { totalMb: number; freeMb: number; freePercent: number } {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  try {
    const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });
    const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;
    const parsePage = (label: string): number => {
      const match = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
      return match ? parseInt(match[1], 10) : 0;
    };
    const available = parsePage('Pages free') + parsePage('Pages inactive') + parsePage('Pages purgeable') + parsePage('Pages speculative');
    const freeMb = Math.round((available * pageSize) / (1024 * 1024));
    return { totalMb, freeMb: Math.max(0, freeMb), freePercent: (freeMb / totalMb) * 100 };
  } catch {
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    return { totalMb, freeMb, freePercent: (freeMb / totalMb) * 100 };
  }
}

function checkSystemMemory(): void {
  const { freeMb, freePercent } = getMacAvailableMemoryMb();
  const level = readLevel(levelRuns, 'memory_low', freePercent < 10);
  log(freePercent < 10 ? 'warn' : 'debug', 'System memory', { freeMb, freePercent: freePercent.toFixed(1) });
  if (level === 'low') {
    alert('memory_low', `Watchdog: System memory low, ${freeMb}MB free (${freePercent.toFixed(0)}%). Will follow up when resolved.`, `Memory low: ${freeMb}MB`);
  } else if (level === 'ok') {
    resolveAndTell('memory_low', `Watchdog: Memory recovered, ${freeMb}MB free (${freePercent.toFixed(0)}%)`);
  }
}

function checkDiskSpace(): void {
  try {
    const result = execSync(`df -k "${DOJO_DIR}" | tail -1`, { encoding: 'utf-8', timeout: 5000 });
    const parts = result.trim().split(/\s+/);
    const availableKb = parseInt(parts[3] ?? '0', 10);
    const availableGb = availableKb / (1024 * 1024);

    // Ordered against the platform's own refusals: never below the point a
    // pre-migration backup, and so an update, is refused (disk-floor.ts).
    const floor = diskFloorBytes();
    const floorGb = toGb(floor.bytes);

    const level = readLevel(levelRuns, 'disk_low', availableGb < floorGb);
    log(availableGb < floorGb ? 'warn' : 'debug', 'Disk space', {
      availableGb: availableGb.toFixed(2), floorGb: floorGb.toFixed(2), binding: floor.binding,
    });
    if (level === 'low') {
      // The owner is told WHICH answer set the number: an unaccountable threshold gets ignored.
      const because = floor.binding === 'backup'
        ? ` This box needs about ${floorGb.toFixed(1)}GB free to keep making a database backup before it updates.`
        : '';
      alert('disk_low', `Watchdog: Disk space low, ${availableGb.toFixed(1)}GB free.${because} Will follow up when resolved.`,
        `Disk space low: ${availableGb.toFixed(1)}GB (floor ${floorGb.toFixed(1)}GB, ${floor.binding})`);
    } else if (level === 'ok') {
      resolveAndTell('disk_low', `Watchdog: Disk space recovered, ${availableGb.toFixed(1)}GB free.`);
    }
  } catch {
    log('debug', 'Could not check disk space');
  }
}

// The database failing its integrity check is owner-told, like the platform-down and update alerts.
function alertDbIntegrity(status: string): void {
  log('error', 'Database integrity check FAILED', { status });
  // Recorded whether or not a text can go (the dashboard's health page and history read it).
  recordAlert(`DB integrity: ${status}`);
  if (sendAlert(state, 'db_integrity', getImessageRecipient(), `Watchdog: Database integrity check failed, ${status}`, sendIMessage)) saveState();
}

function checkDatabaseIntegrity(): void {
  state.lastIntegrityAt = Date.now();
  saveState();
  try {
    if (!fs.existsSync(DB_PATH)) return;

    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('busy_timeout = 3000');
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    db.close();

    const status = result[0]?.integrity_check ?? 'unknown';
    if (status !== 'ok') {
      alertDbIntegrity(status);
    } else {
      markAlertResolved('db_integrity');
      log('debug', 'Database integrity OK');
    }
  } catch (err) {
    log('error', 'Database integrity check error', {
      error: err instanceof Error ? err.message : String(err),
    });
    // A file too damaged for the check to run THROWS rather than answering; that is the worst
    // case and must reach the owner like any other integrity failure. Busy/locked stays quiet.
    const damaged = integrityFailureFromError(err);
    if (damaged) alertDbIntegrity(damaged);
  }
}

function rotateWatchdogLog(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size > 5 * 1024 * 1024) { // > 5MB
      const rotated = LOG_PATH + '.1';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(LOG_PATH, rotated);
      log('info', 'Watchdog log rotated');
    }
  } catch { /* ignore */ }
}

// Quiet health probe (no logging) used as the fallback restart's double-start guard. Separate from
// checkPlatformHealth so a pre-spawn check doesn't emit a misleading "Platform unreachable" line.
async function isPlatformResponding(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function attemptRestart(): Promise<void> {
  log('warn', 'Attempting to restart Dojo platform');

  // Primary path: launchd kickstart of the supervised job, works whenever supervision is intact.
  try {
    execSync('launchctl kickstart -k gui/$(id -u)/com.dojo.platform', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    log('info', 'Restart command sent via launchctl');
    return;
  } catch {
    // launchctl failed (job likely unloaded, when a fallback matters most): fall through to a direct spawn.
    log('warn', 'launchctl kickstart failed, falling back to a direct entrypoint spawn');
  }

  // Run the compiled entrypoint directly and detached: an emergency restart must work with launchd broken.
  try {
    const platformDir = path.join(DOJO_DIR, 'platform');
    const entrypoint = path.join(platformDir, 'packages', 'server', 'dist', 'index.js');
    if (!fs.existsSync(entrypoint)) {
      log('error', 'Fallback restart skipped, server entrypoint not found', { entrypoint });
      return;
    }
    // Double-start guard: a KeepAlive revival may have already brought the platform back
    // (or it never truly died); if it answers health, do NOT spawn a second copy.
    if (await isPlatformResponding()) {
      log('info', 'Fallback restart skipped, platform is already responding');
      return;
    }
    // The exec failure arrives ASYNCHRONOUSLY, outside this try/catch; an 'error' event with no
    // listener is rethrown and kills this daemon on the emergency path.
    const child = spawn(process.execPath, [entrypoint], {
      cwd: platformDir,
      env: { ...process.env, NODE_ENV: 'production' },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      log('error', 'Fallback restart spawn failed', {
        error: err instanceof Error ? err.message : String(err), entrypoint,
      });
    });
    child.unref();
    log('info', 'Restart attempted via direct entrypoint spawn', { pid: child.pid ?? null, entrypoint });
  } catch (err) {
    log('error', 'Restart failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Update-recovery path, NOT the generic platform-down cascade: act ONLY when the update-state marker
// PROVES a failing self-update episode (booting-new/rolled-back with its gate tripped): roll back
// once via rollback.sh (which also puts the data back when the update changed it), or escalate. Returns true when handled, so
// runCheck skips the generic cascade that would kickstart the same bad build and race rollback.sh.
async function maybeAutoRollback(): Promise<boolean> {
  // THE DECISION IS MADE INSIDE THE LOCK: reading first and writing a transition built on that read
  // is a lost update against the platform's boot sentinel, which could erase the record of the data
  // copy (full argument: `auto-rollback.ts`, THE SERIALISED WRITE PATH).
  const seen: { marker: UpdateMarker | null; decision: RollbackDecision } = {
    marker: null,
    decision: { action: 'none' },
  };
  updateMarker((fresh) => {
    seen.marker = fresh;
    const d = decideAutoRollback(fresh, Date.now());
    seen.decision = d;
    if (!fresh || d.action === 'none') return null;
    return d.action === 'escalate' ? toFailedPermanently(fresh, d.reason) : toRolledBack(fresh);
  });
  const marker = seen.marker;
  const decision = seen.decision;
  if (!marker || decision.action === 'none') return false;

  if (decision.action === 'escalate') {
    // The terminal state was recorded inside the lock above. Alert once, loud. This is also the word when
    // rollback.sh left no outcome (it was killed): the one rollback is spent and Dojo is still down.
    log('error', 'D-F: escalating a failed self-update to failed-permanently (no auto-rollback)', {
      reason: decision.reason,
      targetVersion: marker.targetVersion,
      previousVersion: marker.previousVersion,
      rollbackCount: marker.rollbackCount,
    });
    alert('auto_rollback_failed',
      'Watchdog: a Dojo update failed to start, and Dojo is still not running after I tried to put the previous version back, '
      + 'so I am not trying again. Please get help, or see ~/.dojo/scripts/IF-AN-UPDATE-FAILS.md.',
      'Auto-rollback escalated to failed-permanently');
    return true;
  }

  // decision.action === 'rollback'. The owner is told what rollback.sh did once it has run (tellRollbackResult).
  log('warn', 'D-F: self-update did not come up healthy, auto-rolling back to the previous build', {
    targetVersion: marker.targetVersion,
    previousVersion: marker.previousVersion,
    bootAttempts: marker.bootAttempts,
    firstBootAt: marker.firstBootAt,
  });
  const pid = spawnRollbackDetached(undefined, (err) => {
    log('error', 'D-F: rollback.sh could not be executed (async spawn error)', {
      error: err.message, script: ROLLBACK_SCRIPT,
    });
  }, ['--auto']);
  if (pid === null) {
    log('error', 'D-F: rollback.sh could not be spawned (missing script or exec error)', { script: ROLLBACK_SCRIPT });
  } else {
    log('info', 'D-F: rollback.sh spawned detached', { pid, script: ROLLBACK_SCRIPT });
  }
  return true;
}

// rollback.sh --auto leaves its outcome on disk (it unloads this daemon while it works): tell it, and
// remove it only once told, so a crash or a failed send retries next check. True when it was a restored
// build's sentence, which is then this check's one "back" text.
function tellRollbackResult(healthy: boolean): boolean {
  const result = readRollbackResult();
  if (!result) return false;
  updateMarker((m) => (m ? afterRollbackResult(m, result) : null));
  log(result.kind.startsWith('restored') ? 'info' : 'error', 'D-F: rollback.sh finished', { ...result });
  const to = getImessageRecipient();
  if (!tellRollbackOutcome(state, result.kind, result.text, to, sendIMessage, healthy)) return false;
  fs.rmSync(ROLLBACK_RESULT_PATH, { force: true });
  recordAlert(`Auto-rollback: ${result.kind}`);
  return result.kind.startsWith('restored');
}

// A missing platform folder is a swap cut off between its two renames; nothing inside the platform
// can repair that, so this daemon does (`rollback.sh --heal`). Returns true when it acted.
function logHealSpawnError(err: Error): void {
  log('error', 't197: rollback.sh --heal could not be executed', { error: err.message, script: ROLLBACK_SCRIPT });
}
function maybeHealSwap(): boolean {
  const marker = readMarker();
  const heal = decideSwapHeal(DOJO_DIR, marker);
  const to = getImessageRecipient();
  if (heal.action !== 'heal') {
    // Told once: the record goes quiet first, so overlapping cycles cannot both send.
    if (marker?.phase === 'interrupted' && to && claimInterruptedNotice(marker)) sendIMessage(to, interruptedUpdateText(marker));
    return false;
  }
  log('error', 't197: the platform folder is missing; repairing the cut-off swap', { finishes: heal.finishes });
  alert('platform_missing', heal.text, `Platform folder missing: ${heal.finishes}`);
  if (heal.finishes !== 'nothing-to-restore') spawnRollbackDetached(ROLLBACK_SCRIPT, logHealSpawnError, ['--heal']);
  return true;
}

async function runCheck(): Promise<void> {
  log('info', 'Running watchdog check cycle');

  recordHeartbeat();

  // 0. A missing platform folder is repaired before health is judged.
  if (maybeHealSwap()) return;

  // 1. Platform health
  const healthy = await checkPlatformHealth();

  // 1b. A PROVEN-failing self-update takes precedence over the generic cascade: roll back or
  // escalate, then short-circuit so we do not kickstart the same bad build and race rollback.sh.
  const toldResult = tellRollbackResult(healthy);
  if (!healthy && await maybeAutoRollback()) return;

  if (!healthy) {
    // `consecutiveFailures` is the TRUTHFUL count (resets only on recovery); `failuresSinceRestart`
    // is the cadence counter and the only thing a restart resets, so the texted count stays honest.
    consecutiveFailures++;
    failuresSinceRestart++;
    log('warn', `Platform unhealthy (${consecutiveFailures} consecutive failures, ${restartAttempts} restart attempt(s) this outage)`, {
      consecutiveFailures, failuresSinceRestart, restartAttempts,
      lastRestartAt: lastRestartAt ? new Date(lastRestartAt).toISOString() : null,
    });

    // Restart every MAX_FAILURES_BEFORE_RESTART failed checks; only the cadence counter resets, the
    // truthful count keeps climbing. While an update is starting the kickstart waits (the cadence
    // counter is not reset) so the next cycle proceeds once the window passes.
    const marker = readMarker();
    if (failuresSinceRestart >= MAX_FAILURES_BEFORE_RESTART) {
      if (updateIsStarting(marker, Date.now())) {
        log('info', 'Holding platform restart: an update is still in its first start, inside the allowed window', {
          consecutiveFailures, failuresSinceRestart,
        });
      } else {
        await attemptRestart();
        restartAttempts++;
        lastRestartAt = Date.now();
        failuresSinceRestart = 0;
      }
    }

    const counts = { failures: consecutiveFailures, sinceRestart: failuresSinceRestart, restarts: restartAttempts };
    for (const [key, text, record] of outageTexts(state, marker, Date.now(), counts)) alert(key, text, record);
  } else {
    // The recovery log fires whenever there were prior failures, even below the alert threshold.
    if (consecutiveFailures > 0) {
      log('info', 'Platform recovered', { previousFailures: consecutiveFailures });
    }
    if (tellBack(state, getImessageRecipient(), sendIMessage, toldResult)) saveState();
    // Recovery is the ONLY place the truthful counter and restart bookkeeping reset.
    consecutiveFailures = 0;
    failuresSinceRestart = 0;
    restartAttempts = 0;
    lastRestartAt = 0;
  }

  checkSystemMemory();
  checkDiskSpace();
  if (integrityDue(state.lastIntegrityAt, readMarker(), Date.now())) checkDatabaseIntegrity();
  rotateWatchdogLog();
}


// Reload the persisted ledger BEFORE the first cycle: a KeepAlive restart mid-incident must not
// re-alert still-active issues or lose a recovery that resolved while we were down.
loadState();

log('info', 'Dojo Watchdog starting', {
  platformUrl: PLATFORM_URL,
  checkIntervalMs: CHECK_INTERVAL_MS,
  imessageRecipient: getImessageRecipient() ? '***' : 'not configured',
});

// Run immediately, then on interval
runCheck().catch(err => {
  log('error', 'Initial check failed', { error: err instanceof Error ? err.message : String(err) });
});

setInterval(() => {
  runCheck().catch(err => {
    log('error', 'Check cycle failed', { error: err instanceof Error ? err.message : String(err) });
  });
}, CHECK_INTERVAL_MS);

// THE LAST NET: Node's default for both handlers is print-and-exit. Staying up is deliberate: the
// alternative to a degraded watchdog is NO watchdog; everything durable is rewritten every cycle.
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception — the watchdog is staying up and continuing to watch', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled promise rejection — the watchdog is staying up and continuing to watch', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Watchdog shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'Watchdog shutting down (SIGINT)');
  process.exit(0);
});
