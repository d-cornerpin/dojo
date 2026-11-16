// Watchdog alert dedup / recovery ledger: what the watchdog texts the owner about, and nothing else.
// First occurrence sends, a still-active issue waits 2 hours,
// a resolution sends one recovery; persisted so the rules hold across a restart.

import fs from 'node:fs';
import path from 'node:path';

export const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export type AlertLedger = Record<string, { lastSentAt: number; active: boolean }>;

export type AlertKey = 'platform_down' | 'platform_missing' | 'platform_restart_failed' | 'auto_rollback' | 'auto_rollback_failed'
  | 'memory_low' | 'disk_low' | 'db_integrity';

export interface WatchdogState {
  lastHeartbeat: string | null;
  lastAlert: { message: string; at: string } | null;
  alertState: AlertLedger;
}

export function emptyState(): WatchdogState {
  return { lastHeartbeat: null, lastAlert: null, alertState: {} };
}

/** A corrupt or unreadable store starts CLEAN: an unstartable watchdog is worse than one
 *  that re-alerts once. Fields are validated so a bad file cannot put NaN in the cooldown math. */
export function readState(statePath: string): WatchdogState {
  try {
    if (!fs.existsSync(statePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<WatchdogState>;
    const ledger: AlertLedger = {};
    if (parsed.alertState && typeof parsed.alertState === 'object') {
      for (const [key, val] of Object.entries(parsed.alertState)) {
        const v = val as { lastSentAt?: unknown; active?: unknown } | null;
        if (v && typeof v.lastSentAt === 'number' && Number.isFinite(v.lastSentAt) && typeof v.active === 'boolean') {
          ledger[key] = { lastSentAt: v.lastSentAt, active: v.active };
        }
      }
    }
    return {
      lastHeartbeat: typeof parsed.lastHeartbeat === 'string' ? parsed.lastHeartbeat : null,
      lastAlert: parsed.lastAlert && typeof parsed.lastAlert.message === 'string' && typeof parsed.lastAlert.at === 'string'
        ? { message: parsed.lastAlert.message, at: parsed.lastAlert.at }
        : null,
      alertState: ledger,
    };
  } catch {
    return emptyState();
  }
}

let tmpCounter = 0;

/** Crash-safe write (temp then rename); the temp name carries the pid because a KeepAlive revival
 *  can briefly overlap its predecessor. Best-effort: never throws into the check cycle. */
export function persistState(state: WatchdogState, statePath: string): boolean {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${statePath}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

/** Should this alert go out now? Mutates `state` when yes so the caller persists once. */
export function shouldSendAlert(state: WatchdogState, alertKey: string, nowMs: number = Date.now()): boolean {
  const entry = state.alertState[alertKey];
  if (!entry || !entry.active) {
    state.alertState[alertKey] = { lastSentAt: nowMs, active: true };
    return true;
  }
  if (nowMs - entry.lastSentAt > ALERT_COOLDOWN_MS) {
    state.alertState[alertKey] = { lastSentAt: nowMs, active: true };
    return true;
  }
  return false;
}

/** `shouldSendAlert`, but only with a recipient: an alert that could not be sent is not recorded
 *  as "already told", which would silence it through the cooldown and orphan its later recovery. */
export function claimAlert(state: WatchdogState, alertKey: AlertKey, recipient: string, nowMs: number = Date.now()): boolean {
  if (!recipient) return false;
  return shouldSendAlert(state, alertKey, nowMs);
}

/** Retire an active alert silently; true exactly once per incident. */
export function markAlertResolved(state: WatchdogState, alertKey: string): boolean {
  const entry = state.alertState[alertKey];
  if (entry?.active) {
    state.alertState[alertKey] = { lastSentAt: entry.lastSentAt, active: false };
    return true;
  }
  return false;
}

export type Send = (recipient: string, text: string) => boolean;

/** Claim, then send; a send that failed gives the claim back, so the next check tries again. */
export function sendAlert(state: WatchdogState, alertKey: AlertKey, recipient: string, text: string, send: Send, nowMs: number = Date.now()): boolean {
  const before = state.alertState[alertKey];
  if (!claimAlert(state, alertKey, recipient, nowMs)) return false;
  if (send(recipient, text)) return true;
  if (before) state.alertState[alertKey] = before; else delete state.alertState[alertKey];
  return false;
}

/** The one recovery text for an active alert; the alert is retired only once that text went out. */
export function sendRecovery(state: WatchdogState, alertKey: AlertKey, recipient: string, text: string, send: Send): boolean {
  return !!state.alertState[alertKey]?.active && send(recipient, text) && markAlertResolved(state, alertKey);
}

// A level (memory, disk) changes state only after this many checks in a row, so a reading near its line does not flap.
export const DWELL_CHECKS = 3;

/** One reading of a level: 'low' once the bad run is long enough, 'ok' once the good run is, else null.
 *  `runs` counts checks in a row per level (positive bad, negative good). */
export function readLevel(runs: Record<string, number>, alertKey: AlertKey, bad: boolean): 'low' | 'ok' | null {
  const run = bad ? Math.max(runs[alertKey] ?? 0, 0) + 1 : Math.min(runs[alertKey] ?? 0, 0) - 1;
  runs[alertKey] = run;
  return run >= DWELL_CHECKS ? 'low' : run <= -DWELL_CHECKS ? 'ok' : null;
}

/** Plain words for a database so damaged that `PRAGMA integrity_check` THROWS instead of returning rows
 *  (SQLITE_CORRUPT, SQLITE_NOTADB). Null otherwise: busy, locked, unopenable stay quiet. */
export function integrityFailureFromError(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return null;
  if (code.startsWith('SQLITE_CORRUPT')) return 'database disk image is malformed';
  if (code === 'SQLITE_NOTADB') return 'file is not a database';
  return null;
}
