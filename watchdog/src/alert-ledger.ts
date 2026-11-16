// The watchdog's pure decisions: the alert ledger (first occurrence sends, a still-active issue waits 2 hours,
// a resolution sends one recovery; persisted across a restart) and which texts and checks are due when.

import fs from 'node:fs';
import path from 'node:path';
import { updateIsStarting, updateOwnsOutage, type UpdateMarker } from './auto-rollback.js';

export const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// `failures` counts sends of this alert that failed in a row.
export type AlertLedger = Record<string, { lastSentAt: number; active: boolean; failures?: number }>;

export type AlertKey = 'platform_down' | 'platform_missing' | 'platform_restart_failed' | 'auto_rollback' | 'auto_rollback_failed'
  | 'memory_low' | 'disk_low' | 'db_integrity';

export interface WatchdogState {
  lastHeartbeat: string | null;
  lastAlert: { message: string; at: string } | null;
  alertState: AlertLedger;
  lastIntegrityAt: number | null;
}

export function emptyState(): WatchdogState {
  return { lastHeartbeat: null, lastAlert: null, alertState: {}, lastIntegrityAt: null };
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
        const v = val as { lastSentAt?: unknown; active?: unknown; failures?: unknown } | null;
        if (v && typeof v.lastSentAt === 'number' && Number.isFinite(v.lastSentAt) && typeof v.active === 'boolean') {
          ledger[key] = { lastSentAt: v.lastSentAt, active: v.active, ...(typeof v.failures === 'number' ? { failures: v.failures } : {}) };
        }
      }
    }
    return {
      lastHeartbeat: typeof parsed.lastHeartbeat === 'string' ? parsed.lastHeartbeat : null,
      lastAlert: parsed.lastAlert && typeof parsed.lastAlert.message === 'string' && typeof parsed.lastAlert.at === 'string'
        ? { message: parsed.lastAlert.message, at: parsed.lastAlert.at }
        : null,
      alertState: ledger,
      lastIntegrityAt: typeof parsed.lastIntegrityAt === 'number' ? parsed.lastIntegrityAt : null,
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

/** Retire an active alert silently; true exactly once per incident. Its failed-send count ends with it. */
export function markAlertResolved(state: WatchdogState, alertKey: string): boolean {
  const entry = state.alertState[alertKey];
  if (entry) delete entry.failures;
  if (entry?.active) {
    state.alertState[alertKey] = { lastSentAt: entry.lastSentAt, active: false };
    return true;
  }
  return false;
}

export type Send = (recipient: string, text: string) => boolean;

// A send counts only when osascript confirmed it in time; a slow Messages can still deliver a "failed" one,
// so after this many failures in a row the text counts as sent and the ordinary cooldown follows.
export const SEND_TRIES = 3;

/** Claim, then send; a failed send gives the claim back, so the next check tries again (up to SEND_TRIES). */
export function sendAlert(state: WatchdogState, alertKey: AlertKey, recipient: string, text: string, send: Send, nowMs: number = Date.now()): boolean {
  const before = state.alertState[alertKey];
  if (!claimAlert(state, alertKey, recipient, nowMs)) return false;
  if (send(recipient, text)) return true;
  const failures = (before?.failures ?? 0) + 1;
  if (failures < SEND_TRIES) state.alertState[alertKey] = { ...(before ?? { lastSentAt: 0, active: false }), failures };
  return false;
}

/** Send a recovery text for an active alert: true once it went out, or once SEND_TRIES have failed in a row. */
function recoveryTold(state: WatchdogState, alertKey: AlertKey, recipient: string, text: string, send: Send): boolean {
  const entry = state.alertState[alertKey];
  if (!entry?.active || !recipient) return false;
  if (send(recipient, text)) return true;
  entry.failures = (entry.failures ?? 0) + 1;
  return entry.failures >= SEND_TRIES;
}

/** The one recovery text for an active alert; the alert is retired only once that text was told. */
export function sendRecovery(state: WatchdogState, alertKey: AlertKey, recipient: string, text: string, send: Send): boolean {
  return recoveryTold(state, alertKey, recipient, text, send) && markAlertResolved(state, alertKey);
}

/** Tell rollback.sh's outcome sentence; true once told (sent, or SEND_TRIES failed in a row), when the caller
 *  removes the result. A "back" text is owed later, except for a restored build already healthy now. */
export function tellRollbackOutcome(state: WatchdogState, kind: string, text: string, recipient: string, send: Send,
  healthy: boolean, nowMs: number = Date.now()): boolean {
  if (!recipient) return false;
  const restored = kind.startsWith('restored');
  const key: AlertKey = restored ? 'auto_rollback' : 'auto_rollback_failed';
  const sent = send(recipient, text);
  if (!sent) {
    const entry = state.alertState[key] ?? { lastSentAt: 0, active: false };
    state.alertState[key] = { ...entry, failures: (entry.failures ?? 0) + 1 };
    if (state.alertState[key].failures! < SEND_TRIES) return false;
  }
  // Only a sentence that went out holds the generic texts; one given up on leaves them to tell him.
  state.alertState[key] = { lastSentAt: nowMs, active: sent && !(restored && healthy) };
  return true;
}

// What the owner is told when Dojo is healthy again, most specific first; he gets at most one per check.
const BACK_TEXTS: ReadonlyArray<readonly [AlertKey, string]> = [
  ['auto_rollback_failed', 'Watchdog: Dojo is running again and the box is healthy.'],
  ['auto_rollback', 'Watchdog: the rollback worked. Dojo is running again on the previous version and the box is healthy.'],
  ['platform_missing', 'Watchdog: the repair worked. Dojo is back up and healthy.'],
  ['platform_down', 'Watchdog: Dojo platform is back UP and healthy.'],
];

/** A healthy check: send the most specific "back" text that is due (none when another text already told
 *  him this check), then retire the other outage alerts silently. A failed send retires nothing. */
export function tellBack(state: WatchdogState, recipient: string, send: Send, alreadyTold: boolean): boolean {
  const due = BACK_TEXTS.find(([key]) => state.alertState[key]?.active);
  if (due && !alreadyTold && !recoveryTold(state, due[0], recipient, due[1], send)) return false;
  let changed = false;
  for (const key of [...BACK_TEXTS.map(([k]) => k), 'platform_restart_failed']) changed = markAlertResolved(state, key) || changed;
  return changed;
}

// "Down" after this many failed checks in a row; "restart did not help" this many failed checks after a restart.
const FAILURES_BEFORE_ALERT = 3;
const RESTART_GRACE_FAILURES = 2;

/** The generic outage texts due at a failed check, unless an update owns the outage. */
export function outageTexts(state: WatchdogState, marker: UpdateMarker | null, nowMs: number,
  c: { failures: number; sinceRestart: number; restarts: number }): Array<[AlertKey, string, string]> {
  if (updateOwnsOutage(marker, state.alertState, nowMs)) return [];
  const texts: Array<[AlertKey, string, string]> = [];
  if (c.failures >= FAILURES_BEFORE_ALERT) {
    texts.push(['platform_down', `Watchdog: Dojo platform is DOWN (${c.failures} checks failed). Will notify when it recovers.`,
      `Platform down: ${c.failures} checks failed`]);
  }
  if (c.restarts > 0 && c.sinceRestart >= RESTART_GRACE_FAILURES) {
    texts.push(['platform_restart_failed', `Watchdog: I automatically restarted the Dojo platform ${c.restarts} time(s) but it is still down after ${c.failures} failed checks. It needs manual attention.`,
      `Auto-restart did not fix platform: ${c.failures} failed checks, ${c.restarts} restart(s)`]);
  }
  return texts;
}

// The full integrity read of the live database: once a day, and once after an update's first healthy start;
// never while an update is starting. A last time in the future (the clock was set back) counts as due.
export const INTEGRITY_EVERY_MS = 24 * 60 * 60_000;
export function integrityDue(lastAt: number | null, marker: UpdateMarker | null, nowMs: number): boolean {
  if (updateIsStarting(marker, nowMs)) return false;
  if (lastAt === null || nowMs < lastAt || nowMs - lastAt >= INTEGRITY_EVERY_MS) return true;
  return !!marker?.confirmedHealthyAt && Date.parse(marker.confirmedHealthyAt) > lastAt;
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
