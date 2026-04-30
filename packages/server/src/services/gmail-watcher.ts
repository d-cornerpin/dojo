// ════════════════════════════════════════
// Gmail Watcher: Polls for new emails and notifies the primary agent
// Similar to the iMessage bridge but for incoming email
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, getOwnerName } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { googleRead } from '../google/client.js';
import { isGoogleEnabled, isGoogleConnected, getEnabledServices } from '../google/auth.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError } from './watcher-status.js';

const logger = createLogger('gmail-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 300_000; // Check every 5 minutes
const MAX_RESULTS_PER_POLL = 50; // Was 10 — bumped so a weekend backlog or
                                  // delayed-startup catchup doesn't drop emails.

// ── Status state ──
//
// Every poll updates this. Surfaced via getStatus() to the dashboard
// Health page and the GET /api/system/watchers route. Pre-2026-04-30
// the watcher had no surface signal at all — silent failures meant the
// user couldn't tell whether new emails were being delivered.
const status: WatcherStatus = {
  name: 'gmail',
  running: false,
  enabled: false,
  connected: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  lastPollAt: null,
  lastPollOk: null,
  lastPollError: null,
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastCheckedAt: null,
  totalPolls: 0,
  totalNotifications: 0,
  lastNotifiedAt: null,
  recentNotifications: [],
};
let alreadyAlerted = false;
let notificationsSinceFailureAlert = 0;

export function getGmailWatcherStatus(): WatcherStatus {
  // Refresh enabled/connected on every read so the panel reflects current
  // config without waiting for the next poll cycle.
  status.enabled = isGoogleEnabled() && getEnabledServices().gmail;
  status.connected = isGoogleConnected();
  status.running = pollTimer !== null;
  return { ...status, recentNotifications: [...status.recentNotifications] };
}

// ── Persistence ──

function loadLastCheckedAt(): string | null {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'gmail_last_checked_at'").get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(timestamp: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('gmail_last_checked_at', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(timestamp, timestamp);
  } catch (err) {
    logger.error('Failed to save gmail_last_checked_at', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Polling ──

async function pollForNewEmails(): Promise<void> {
  status.totalPolls++;
  // Capture the poll-start time BEFORE the API call so an email arriving
  // during the poll isn't lost. The next poll's floor is set from this,
  // not from "now" after processing finishes.
  const pollStartIso = new Date().toISOString();

  const recordSuccess = (): void => {
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = true;
    status.lastPollError = null;
    status.consecutiveFailures = 0;
    status.firstFailureAt = null;
    if (alreadyAlerted) {
      // Recovered after a failure alert was sent — close the loop with a
      // recovery iMessage so the user doesn't stare at a green panel
      // wondering whether the failure alert was current.
      logger.info('Gmail watcher recovered — sending recovery alert');
      alreadyAlerted = maybeAlertOnRecovery({
        name: 'gmail', alreadyAlerted, totalNotificationsSinceFailure: notificationsSinceFailureAlert,
      });
      notificationsSinceFailureAlert = 0;
    }
  };
  const recordFailure = (rawMsg: string): void => {
    const msg = normalizeError(rawMsg);
    const nowIso = new Date().toISOString();
    status.lastPollAt = nowIso;
    status.lastPollOk = false;
    status.lastPollError = msg;
    status.consecutiveFailures++;
    if (!status.firstFailureAt) status.firstFailureAt = nowIso;
    alreadyAlerted = maybeAlertOnFailure({
      name: 'gmail',
      consecutiveFailures: status.consecutiveFailures,
      firstFailureAt: status.firstFailureAt,
      lastError: msg,
      alreadyAlerted,
    });
  };

  if (!isGoogleEnabled() || !isGoogleConnected()) {
    // Not a "failure" per se — the user has Google off or hasn't auth'd.
    // Record as a non-error skip so the panel shows why nothing's happening.
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = null;
    status.lastPollError = !isGoogleEnabled() ? 'Google integration disabled in Settings' : 'Google not connected — re-auth in Settings';
    return;
  }

  const services = getEnabledServices();
  if (!services.gmail) {
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = null;
    status.lastPollError = 'Gmail service disabled in Settings → Google';
    return;
  }

  try {
    // Build query: all inbox emails since lastCheckedAt. Pre-2026-04-30
    // we filtered by is:unread, but that meant any email the user opened
    // on their phone before the next poll fired was silently lost. Now
    // we include all inbox messages and rely on notifiedIds dedup to
    // avoid re-notifying.
    let query = 'in:inbox';
    if (status.lastCheckedAt) {
      // Gmail accepts epoch seconds in after: for second-precision filter.
      // Pre-2026-04-30 we used YYYY/MM/DD which was day-precision and
      // forced re-listing the entire day's emails on every poll.
      const afterEpoch = Math.floor(new Date(status.lastCheckedAt).getTime() / 1000);
      query += ` after:${afterEpoch}`;
    }

    const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${MAX_RESULTS_PER_POLL}`;
    const result = await googleRead(listUrl, 'system', 'Gmail Watcher', 'gmail_inbox_poll', { query });

    if (!result.ok) {
      // Pre-2026-04-30 this was logger.debug, so 401s and connection
      // failures were invisible. Now they're warn-level AND surfaced
      // through getStatus() so the user can see them on the Health page.
      logger.warn('Gmail poll failed', { error: result.error, query });
      recordFailure(result.error ?? 'Unknown poll error');
      return;
    }

    const data = result.data as { messages?: Array<{ id: string; threadId: string }> };

    // Track which message IDs we've already notified about (avoid duplicates across polls)
    const db = getDb();
    const notifiedKey = 'gmail_notified_ids';
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(notifiedKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    if (!data?.messages || data.messages.length === 0) {
      // No new messages, success — advance lastCheckedAt to poll-start time
      // (NOT "now", which would skip any email that arrived during the poll).
      status.lastCheckedAt = pollStartIso;
      saveLastCheckedAt(pollStartIso);
      recordSuccess();
      return;
    }

    const primaryId = getPrimaryAgentId();
    const ownerName = getOwnerName();
    void ownerName; // currently unused; kept for future personalization

    // Get own email to filter out self-sent
    const ownEmail = (() => {
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'gws_account_email'").get() as { value: string } | undefined;
        return row?.value ?? null;
      } catch { return null; }
    })();

    let newCount = 0;

    for (const msg of data.messages) {
      if (notifiedIds.has(msg.id)) continue;

      // Fetch message metadata
      const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
      const detail = await googleRead(detailUrl, 'system', 'Gmail Watcher', 'gmail_read', { messageId: msg.id });

      if (!detail.ok) {
        logger.warn('Gmail message detail fetch failed', { messageId: msg.id, error: detail.error });
        continue;
      }

      const msgData = detail.data as {
        id: string;
        snippet: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };

      const headers = msgData?.payload?.headers ?? [];
      const from = headers.find(h => h.name === 'From')?.value ?? 'Unknown sender';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const snippet = msgData?.snippet ?? '';

      if (ownEmail && from.includes(ownEmail)) {
        // Skip self-sent. Mark as notified so we don't keep re-fetching the
        // same message every poll — pre-2026-04-30 this was a continue with
        // no notifiedIds.add, so self-sent emails got refetched forever.
        notifiedIds.add(msg.id);
        continue;
      }

      // Inject notification into primary agent's conversation
      // IMPORTANT: This is NOT a message from the user. It's an automated notification.
      const content = `[SOURCE: GMAIL NOTIFICATION — not a message from the user, this is an automated alert about a new email that arrived in the inbox]\n\nFrom: ${from}\nSubject: ${subject}\nDate: ${date}\nPreview: ${snippet}\nMessage ID: ${msg.id}`;

      const msgId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'user', ?, datetime('now'))
      `).run(msgId, primaryId, content);

      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: msgId,
          agentId: primaryId,
          role: 'user' as const,
          content,
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });

      notifiedIds.add(msg.id);
      newCount++;
      status.totalNotifications++;
      if (alreadyAlerted) notificationsSinceFailureAlert++;
      status.lastNotifiedAt = new Date().toISOString();
      const recent: RecentNotification = {
        at: status.lastNotifiedAt,
        from,
        subject,
      };
      status.recentNotifications = pushRecent(status.recentNotifications, recent);

      logger.info('New email notification sent to primary agent', {
        from, subject, messageId: msg.id,
      });
    }

    // Trigger the agent runtime if we sent any notifications
    if (newCount > 0) {
      const runtime = getAgentRuntime();
      const summary = newCount === 1
        ? `[SOURCE: GMAIL NOTIFICATION] A new email just arrived. Details are in the previous message.`
        : `[SOURCE: GMAIL NOTIFICATION] ${newCount} new emails just arrived. Details are in the previous messages.`;

      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for new email notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Persist notified IDs (keep last 200 to prevent unbounded growth)
    const recentIds = [...notifiedIds].slice(-200);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(notifiedKey, JSON.stringify(recentIds), JSON.stringify(recentIds));

    status.lastCheckedAt = pollStartIso;
    saveLastCheckedAt(pollStartIso);
    recordSuccess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Gmail poll threw', { error: msg });
    recordFailure(msg);
  }
}

// ── Start/Stop ──

export function startGmailWatcher(): void {
  if (pollTimer) {
    logger.warn('Gmail watcher already running');
    return;
  }

  if (!isGoogleEnabled() || !isGoogleConnected()) {
    logger.info('Gmail watcher: Google not connected, skipping');
    return;
  }

  const services = getEnabledServices();
  if (!services.gmail) {
    logger.info('Gmail watcher: Gmail service not enabled, skipping');
    return;
  }

  status.lastCheckedAt = loadLastCheckedAt();

  // If first run, seed to now so we don't process the entire inbox
  if (!status.lastCheckedAt) {
    status.lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(status.lastCheckedAt);
    logger.info('Gmail watcher: first run, seeded lastCheckedAt to now');
  }

  logger.info('Starting Gmail watcher', {
    pollInterval: POLL_INTERVAL_MS, lastCheckedAt: status.lastCheckedAt,
  });

  pollTimer = setInterval(() => {
    pollForNewEmails().catch(err => {
      logger.error('Gmail poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after a short delay (let the server finish starting)
  setTimeout(() => {
    pollForNewEmails().catch(() => { /* logged inside */ });
  }, 10_000);
}

export function stopGmailWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Gmail watcher stopped');
  }
}

export function isGmailWatcherRunning(): boolean {
  return pollTimer !== null;
}
