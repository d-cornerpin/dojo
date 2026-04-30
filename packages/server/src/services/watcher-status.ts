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
  lastCheckedAt: string | null;   // floor used for next "since" query
  totalPolls: number;
  totalNotifications: number;
  lastNotifiedAt: string | null;
  recentNotifications: RecentNotification[];  // capped to RECENT_CAP
}

export const RECENT_CAP = 10;
export const FAILURE_ALERT_THRESHOLD = 3;

// Threshold-tracking helper — call from inside a watcher when a poll fails.
// Once consecutive failures reach the threshold, broadcast a chat:error to
// the dashboard AND send an iMessage alert. After that, silence the alarm
// until the watcher recovers (so a persistently broken watcher doesn't spam).
export function maybeAlertOnFailure(params: {
  name: WatcherStatus['name'];
  consecutiveFailures: number;
  lastError: string;
  alreadyAlerted: boolean;
}): boolean {
  if (params.consecutiveFailures < FAILURE_ALERT_THRESHOLD) return params.alreadyAlerted;
  if (params.alreadyAlerted) return true;

  const label = params.name === 'gmail' ? 'Gmail watcher' : params.name === 'outlook' ? 'Outlook watcher' : 'Teams watcher';
  const message = `${label} has failed ${params.consecutiveFailures} times in a row. New ${params.name === 'teams' ? 'messages' : 'emails'} are not being delivered to your agents. Last error: ${params.lastError.slice(0, 240)}. Check Settings → ${params.name === 'gmail' ? 'Google' : 'Microsoft'} for connection status, or the Health page for poll history.`;
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

export function pushRecent(list: RecentNotification[], n: RecentNotification): RecentNotification[] {
  const next = [n, ...list];
  return next.slice(0, RECENT_CAP);
}
