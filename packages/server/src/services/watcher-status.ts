// ════════════════════════════════════════
// Shared types and helpers for service watchers (Gmail, Outlook, Teams).
//
// Pre-2026-04-30 the watchers had no observable state — all errors logged
// at debug level, no health surface anywhere. A stuck OAuth token, broken
// poll, or quietly-disabled service was completely invisible. This module
// gives every watcher a uniform status shape so the dashboard Health page
// can show a single panel per watcher with running/connected/last-poll/etc.
// ════════════════════════════════════════

import { broadcast } from '../gateway/ws.js';
import { sendAlert } from './imessage-bridge.js';

export interface RecentNotification {
  at: string;       // ISO timestamp
  from: string;     // human-readable sender
  subject: string;  // subject or short preview
}

export interface WatcherStatus {
  name: 'gmail' | 'outlook' | 'teams';
  running: boolean;          // setInterval is active
  enabled: boolean;          // user-toggle (Settings)
  connected: boolean;        // OAuth state
  pollIntervalMs: number;
  lastPollAt: string | null;
  lastPollOk: boolean | null;     // null = never polled yet
  lastPollError: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;  // ISO start of the current failure streak; null when healthy
  lastCheckedAt: string | null;   // floor used for next "since" query
  totalPolls: number;
  totalNotifications: number;
  lastNotifiedAt: string | null;
  recentNotifications: RecentNotification[];  // capped to RECENT_CAP
}

export const RECENT_CAP = 10;

// Minimum failure duration per watcher before we surface an alert. Pre-2026-04-30
// this was a flat "3 consecutive failures" count, but Teams polls every 15s
// (vs. 5 min for Gmail/Outlook) so 3 failures = 45 seconds — alerting on
// every transient blip and waking the owner for nothing. Time-based is the
// honest signal: the watcher has been broken for at least N minutes.
export const FAILURE_DURATION_MS_DEFAULT: Record<WatcherStatus['name'], number> = {
  gmail: 8 * 60 * 1000,    // ≈ 2 consecutive 5-min polls
  outlook: 8 * 60 * 1000,  // ≈ 2 consecutive 5-min polls
  teams: 5 * 60 * 1000,    // ≈ 20 consecutive 15s polls — quiet buffer for transient blips
};

// Always require at least this many consecutive failures, regardless of
// time elapsed. Single transient errors should never alert, no matter how
// long the watcher has been alive between polls.
export const MIN_CONSECUTIVE_FAILURES_FOR_ALERT = 2;

// Coalesce missing/empty error strings to a stable fallback. Pre-2026-04-30
// recordPollFailure used `error ?? 'fallback'` which only handled null/
// undefined, so an empty-string error (which can come from a thrown Error
// with no message, or a 5xx body that parsed to {error:{message:''}})
// rendered as "Last error: ." in alerts. Normalize here.
export function normalizeError(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(no error message — check server logs)';
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return '(empty error — check server logs)';
  return trimmed;
}

function watcherLabel(name: WatcherStatus['name']): string {
  return name === 'gmail' ? 'Gmail watcher' : name === 'outlook' ? 'Outlook watcher' : 'Teams watcher';
}

// Threshold-tracking helper — call from inside a watcher when a poll fails.
// Alerts when the watcher has been continuously failing for at least
// minFailureDurationMs AND has hit MIN_CONSECUTIVE_FAILURES_FOR_ALERT.
// After that, silences itself until the watcher recovers (so a persistently
// broken watcher doesn't spam).
export function maybeAlertOnFailure(params: {
  name: WatcherStatus['name'];
  consecutiveFailures: number;
  firstFailureAt: string | null;   // ISO when this failure streak started
  minFailureDurationMs?: number;   // override; defaults to FAILURE_DURATION_MS_DEFAULT[name]
  lastError: string;
  alreadyAlerted: boolean;
}): boolean {
  if (params.alreadyAlerted) return true;
  if (params.consecutiveFailures < MIN_CONSECUTIVE_FAILURES_FOR_ALERT) return false;

  const minDurationMs = params.minFailureDurationMs ?? FAILURE_DURATION_MS_DEFAULT[params.name];
  if (!params.firstFailureAt) return false;
  const elapsedMs = Date.now() - new Date(params.firstFailureAt).getTime();
  if (elapsedMs < minDurationMs) return false;

  const label = watcherLabel(params.name);
  const errText = normalizeError(params.lastError).slice(0, 240);
  const elapsedMin = Math.round(elapsedMs / 60000);
  const message = `${label} has been failing for ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'} (${params.consecutiveFailures} consecutive polls). New ${params.name === 'teams' ? 'messages' : 'emails'} are not being delivered to your agents. Last error: ${errText}. Check Settings → ${params.name === 'gmail' ? 'Google' : 'Microsoft'} for connection status, or the Health page for poll history.`;
  try {
    broadcast({
      type: 'chat:error',
      agentId: 'system',
      error: message,
      severity: 'error',
      retryable: false,
    } as never);
  } catch { /* best effort */ }
  try { sendAlert(message, 'warning'); } catch { /* best effort */ }
  return true;
}

// Companion to maybeAlertOnFailure. Call when a watcher recovers (i.e.,
// poll succeeds) AFTER a failure alert was sent. Without this, the user
// gets a "watcher failing" iMessage that may arrive AFTER the watcher has
// already recovered, and they're left wondering what's actually true.
// This sends a brief confirmation so the loop closes on its own.
//
// Returns the new alreadyAlerted state (always false — caller should
// assign to clear).
export function maybeAlertOnRecovery(params: {
  name: WatcherStatus['name'];
  alreadyAlerted: boolean;
  totalNotificationsSinceFailure: number;
}): boolean {
  if (!params.alreadyAlerted) return false;
  const label = watcherLabel(params.name);
  const tail = params.totalNotificationsSinceFailure > 0
    ? ` ${params.totalNotificationsSinceFailure} new ${params.name === 'teams' ? 'message' : 'email'}${params.totalNotificationsSinceFailure === 1 ? '' : 's'} delivered since recovery.`
    : '';
  const message = `${label} has recovered and is polling normally again.${tail}`;
  try {
    broadcast({
      type: 'chat:error',
      agentId: 'system',
      error: message,
      severity: 'info',
      retryable: false,
    } as never);
  } catch { /* best effort */ }
  try { sendAlert(message, 'info'); } catch { /* best effort */ }
  return false;
}

export function pushRecent(list: RecentNotification[], n: RecentNotification): RecentNotification[] {
  const next = [n, ...list];
  return next.slice(0, RECENT_CAP);
}
