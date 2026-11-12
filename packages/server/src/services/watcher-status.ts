// Shared types and helpers for the Gmail, Outlook and Teams watchers: one uniform status shape per watcher
// for the Health page.

import { broadcast } from '../gateway/ws.js';
import { recordFailureTold, clearFailure, watcherFailingOnRecord, watchedForMail } from './watcher-owner-cards.js';
import { settingsPath } from '@dojo/shared';
export { watcherFailingOnRecord, watchedForMail };

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

// Minimum failure duration before an alert. Time-based because Teams polls every 15s, so a
// consecutive-failure count would alert on transient blips.
export const FAILURE_DURATION_MS_DEFAULT: Record<WatcherStatus['name'], number> = {
  gmail: 8 * 60 * 1000,    // ≈ 2 consecutive 5-min polls
  outlook: 8 * 60 * 1000,  // ≈ 2 consecutive 5-min polls
  teams: 5 * 60 * 1000,    // ≈ 20 consecutive 15s polls, a quiet buffer for transient blips
};

// Always require this many consecutive failures, however long the watcher has been alive.
export const MIN_CONSECUTIVE_FAILURES_FOR_ALERT = 2;

// Coalesces null, undefined and empty-string errors to a stable fallback so alerts never read "Last error: .".
export function normalizeError(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(no error message — check server logs)';
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return '(empty error — check server logs)';
  return trimmed;
}

function watcherLabel(name: WatcherStatus['name']): string {
  return name === 'gmail' ? 'Gmail watcher' : name === 'outlook' ? 'Outlook watcher' : 'Teams watcher';
}

// Call when a poll fails: alerts once the watcher has failed for minFailureDurationMs and at least
// MIN_CONSECUTIVE_FAILURES_FOR_ALERT times, then stays silent until it recovers.
// The owner's card for a failing watcher, and its record: services/watcher-owner-cards.ts.

export function maybeAlertOnFailure(params: {
  name: WatcherStatus['name'];
  accountId?: string;               // the failing account; Teams has one, its name
  consecutiveFailures: number;
  firstFailureAt: string | null;   // ISO when this failure streak started
  minFailureDurationMs?: number;   // override; defaults to FAILURE_DURATION_MS_DEFAULT[name]
  lastError: string;
  alreadyAlerted: boolean;
}): boolean {
  const account = params.accountId ?? params.name;
  // Already told by this process or on the record from before a restart: never a second text.
  if (params.alreadyAlerted || watcherFailingOnRecord(params.name, account)) return true;
  if (params.consecutiveFailures < MIN_CONSECUTIVE_FAILURES_FOR_ALERT) return false;

  const minDurationMs = params.minFailureDurationMs ?? FAILURE_DURATION_MS_DEFAULT[params.name];
  if (!params.firstFailureAt) return false;
  const elapsedMs = Date.now() - new Date(params.firstFailureAt).getTime();
  if (elapsedMs < minDurationMs) return false;

  const label = watcherLabel(params.name);
  const elapsedMin = Math.round(elapsedMs / 60000);
  const itemType = params.name === 'teams' ? 'messages' : 'emails';
  const message = `${label} has been failing for ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'}. New ${itemType} aren't reaching your agents. Open ${settingsPath('channels')} to reconnect.`;
  recordFailureTold(params.name, account, message);   // no text: the lasting owner card is how it is heard
  return true;
}

// Call when a watcher recovers after a failure alert, so the earlier alert is not left stale. Returns the
// new alreadyAlerted state (always false).
export function maybeAlertOnRecovery(params: {
  name: WatcherStatus['name'];
  accountId?: string;
  alreadyAlerted: boolean;
  totalNotificationsSinceFailure: number;
}): boolean {
  // The record decides as much as this process's flag: an account that recovered while the server was
  // down still gets its all-clear and its card ended.
  const told = clearFailure(params.name, params.accountId ?? params.name);
  if (!params.alreadyAlerted && told === null) return false;
  const label = watcherLabel(params.name);
  const tail = params.totalNotificationsSinceFailure > 0
    ? ` ${params.totalNotificationsSinceFailure} new ${params.name === 'teams' ? 'message' : 'email'}${params.totalNotificationsSinceFailure === 1 ? '' : 's'} delivered since recovery.`
    : '';
  const message = `${label} has recovered and is polling normally again.${tail}`;
  try {
    broadcast({
      type: 'chat:error', cardClass: 'informational',
      agentId: 'system',
      error: message,
      severity: 'info',
      retryable: false,
    });
  } catch { /* best effort */ }
  return false;
}

export function pushRecent(list: RecentNotification[], n: RecentNotification): RecentNotification[] {
  const next = [n, ...list];
  return next.slice(0, RECENT_CAP);
}
