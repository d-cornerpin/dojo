// ════════════════════════════════════════
// Watchdog alert dedup / recovery ledger (FA-W5 / FA-W6).
//
// Extracted from index.ts by SWEEP CORE-2 item 6 — MOVED, not rewritten: the
// cooldown, the send-once rule and the always-send-recovery rule are the same
// ones FA-W6 landed, and `index.ts` is the only caller.
//
// WHY IT MOVED. `index.ts` starts a daemon at import: it runs a check cycle,
// installs a 2-minute interval and opens the platform DB. So the ledger could
// not be driven by a test without starting a watchdog, which meant the piece
// SWEEP-F T5 names — "alert dedup/recovery ledger persisted (restart loses no
// recovery message)" — could only ever be READ rather than proven. This file is
// side-effect free at import, exactly like auto-rollback.ts and for the same
// reason.
//
// WHAT IT IS. The watchdog used to keep this ledger in process memory only, so a
// launchd KeepAlive restart mid-incident wiped it: still-active issues re-alerted
// and recoveries for issues that resolved while it was down were lost entirely
// (FA-W6). It lives in a small JSON file the watchdog alone owns, beside its
// heartbeat, so the watchdog keeps strict read-only discipline over the platform
// DB and its dedup/recovery contract survives a restart.
// ════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

// First occurrence: send immediately. Same issue still active: suppress for 2
// hours. Issue resolved: send a recovery message, once.
export const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export type AlertLedger = Record<string, { lastSentAt: number; active: boolean }>;

export interface WatchdogState {
  /** Liveness the platform reads (FA-W5). */
  lastHeartbeat: string | null;
  lastAlert: { message: string; at: string } | null;
  /** Alert dedup/recovery ledger (FA-W6): persisted so send-once, the 2h
   *  cooldown and always-send-recovery hold ACROSS a KeepAlive restart. */
  alertState: AlertLedger;
}

export function emptyState(): WatchdogState {
  return { lastHeartbeat: null, lastAlert: null, alertState: {} };
}

/**
 * Read the persisted state. A corrupt or unreadable store starts CLEAN rather
 * than crashing the daemon: the worst case is one restart's dedup/recovery
 * slipping (the pre-FA-W6 behaviour), and a watchdog that will not start because
 * its own bookkeeping file is malformed is worse than one that re-alerts once.
 *
 * Every entry is validated field by field — a hand-edited or half-written file
 * must not be able to put a string where a timestamp belongs and have the
 * cooldown arithmetic silently produce NaN (which compares false against every
 * bound, i.e. suppresses every alert for ever).
 */
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

/**
 * Crash-safe atomic write: temp file then rename (rename is atomic on POSIX, so
 * a crash mid-write can never leave a half-written store — a reader sees either
 * the old file or the new one). Chosen over a tiny sqlite: one small document,
 * no schema, no second DB to keep read-only-safe.
 *
 * The temp name carries the pid: the watchdog is restarted by launchd and a
 * KeepAlive revival can briefly overlap its predecessor, so a fixed `.tmp` is
 * two processes writing one buffer.
 *
 * Returns whether it persisted. Best-effort: never throws into the check cycle.
 */
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

/**
 * Should this alert go out now? Mutates `state` when the answer is yes, so the
 * caller persists once afterwards. `nowMs` is a parameter so the cooldown can be
 * driven without waiting two hours.
 */
export function shouldSendAlert(state: WatchdogState, alertKey: string, nowMs: number = Date.now()): boolean {
  const entry = state.alertState[alertKey];
  if (!entry || !entry.active) {
    // First time, or the issue had resolved and has come back.
    state.alertState[alertKey] = { lastSentAt: nowMs, active: true };
    return true;
  }
  if (nowMs - entry.lastSentAt > ALERT_COOLDOWN_MS) {
    state.alertState[alertKey] = { lastSentAt: nowMs, active: true };
    return true;
  }
  return false;
}

/**
 * Retire an active alert. Returns true exactly once per incident — when the
 * alert WAS active — which is the caller's signal to send the recovery message.
 *
 * CALL ORDER MATTERS AND THE CALLERS ARE HELD TO IT (SWEEP CORE-2 item 6): this
 * must not run until the recovery message has somewhere to go. Retiring the
 * entry first and then discovering there is no recipient drops the owner's "it
 * is back" message permanently — the ledger now says nothing was ever active, so
 * nothing will ever retry it, and he is left holding a "Dojo platform is DOWN"
 * text with no sequel. `index.ts` resolves the recipient first; the
 * watchdog-self-integrity suite refuses the other order.
 */
export function markAlertResolved(state: WatchdogState, alertKey: string): boolean {
  const entry = state.alertState[alertKey];
  if (entry?.active) {
    state.alertState[alertKey] = { lastSentAt: entry.lastSentAt, active: false };
    return true;
  }
  return false;
}
