// ════════════════════════════════════════
// Outlook Watcher: Polls for new Outlook emails and notifies the primary agent
// Mirrors the Gmail watcher but uses Microsoft Graph API
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { msGraphRead } from '../microsoft/client.js';
import { isMicrosoftEnabled, isMicrosoftConnected, getEnabledMsServices } from '../microsoft/auth.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError } from './watcher-status.js';

const logger = createLogger('outlook-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 300_000; // Check every 5 minutes (same as Gmail)
const MAX_RESULTS_PER_POLL = 50;

// ── Status state ──
const status: WatcherStatus = {
  name: 'outlook',
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

export function getOutlookWatcherStatus(): WatcherStatus {
  status.enabled = isMicrosoftEnabled() && getEnabledMsServices().outlook;
  status.connected = isMicrosoftConnected();
  status.running = pollTimer !== null;
  return { ...status, recentNotifications: [...status.recentNotifications] };
}

// ── Persistence ──

function loadLastCheckedAt(): string | null {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'outlook_last_checked_at'").get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(timestamp: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('outlook_last_checked_at', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(timestamp, timestamp);
  } catch (err) {
    logger.error('Failed to save outlook_last_checked_at', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Polling ──

async function pollForNewEmails(): Promise<void> {
  status.totalPolls++;
  const pollStartIso = new Date().toISOString();

  const recordSuccess = (): void => {
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = true;
    status.lastPollError = null;
    status.consecutiveFailures = 0;
    status.firstFailureAt = null;
    if (alreadyAlerted) {
      logger.info('Outlook watcher recovered — sending recovery alert');
      alreadyAlerted = maybeAlertOnRecovery({
        name: 'outlook', alreadyAlerted, totalNotificationsSinceFailure: notificationsSinceFailureAlert,
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
      name: 'outlook',
      consecutiveFailures: status.consecutiveFailures,
      firstFailureAt: status.firstFailureAt,
      lastError: msg,
      alreadyAlerted,
    });
  };

  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) {
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = null;
    status.lastPollError = !isMicrosoftEnabled() ? 'Microsoft integration disabled in Settings' : 'Microsoft not connected — re-auth in Settings';
    return;
  }

  const services = getEnabledMsServices();
  if (!services.outlook) {
    status.lastPollAt = new Date().toISOString();
    status.lastPollOk = null;
    status.lastPollError = 'Outlook service disabled in Settings → Microsoft';
    return;
  }

  try {
    // Build filter: all inbox emails since lastCheckedAt. Pre-2026-04-30
    // we filtered by isRead eq false, but that meant any email the user
    // opened on their phone before the next poll fired was silently lost.
    // Now we include all inbox messages and rely on notifiedIds dedup.
    const filter = status.lastCheckedAt
      ? `receivedDateTime gt ${status.lastCheckedAt}`
      : null;
    const filterClause = filter ? `&$filter=${encodeURIComponent(filter)}` : '';
    const endpoint = `me/mailFolders/inbox/messages?$top=${MAX_RESULTS_PER_POLL}${filterClause}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`;

    const result = await msGraphRead(endpoint, 'system', 'Outlook Watcher', 'outlook_inbox_poll', { filter });

    if (!result.ok) {
      logger.warn('Outlook poll failed', { error: result.error });
      recordFailure(result.error ?? 'Unknown poll error');
      return;
    }

    const data = result.data as { value?: Array<{ id: string; from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; receivedDateTime?: string; bodyPreview?: string }> };
    if (!data?.value || data.value.length === 0) {
      status.lastCheckedAt = pollStartIso;
      saveLastCheckedAt(pollStartIso);
      recordSuccess();
      return;
    }

    const db = getDb();
    const primaryId = getPrimaryAgentId();

    // Track which message IDs we've already notified about
    const notifiedKey = 'outlook_notified_ids';
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(notifiedKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    // Get own email to filter out self-sent messages
    const ownEmail = (() => {
      try {
        const row = db.prepare("SELECT value FROM config WHERE key = 'ms_account_email'").get() as { value: string } | undefined;
        return row?.value ?? null;
      } catch { return null; }
    })();

    let newCount = 0;

    for (const msg of data.value) {
      if (notifiedIds.has(msg.id)) continue;

      const fromName = msg.from?.emailAddress?.name ?? '';
      const fromAddress = msg.from?.emailAddress?.address ?? 'Unknown sender';
      const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
      const subject = msg.subject ?? '(no subject)';
      const date = msg.receivedDateTime ?? '';
      const snippet = msg.bodyPreview ?? '';

      if (ownEmail && fromAddress.toLowerCase() === ownEmail.toLowerCase()) {
        notifiedIds.add(msg.id);
        continue;
      }

      const content = `[SOURCE: OUTLOOK NOTIFICATION — not a message from the user, this is an automated alert about a new email that arrived in the Outlook inbox]\n\nFrom: ${from}\nSubject: ${subject}\nDate: ${date}\nPreview: ${snippet}\nMessage ID: ${msg.id}`;

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
      status.recentNotifications = pushRecent(status.recentNotifications, {
        at: status.lastNotifiedAt, from, subject,
      });

      logger.info('New Outlook email notification sent to primary agent', {
        from, subject, messageId: msg.id,
      });
    }

    if (newCount > 0) {
      const runtime = getAgentRuntime();
      const summary = newCount === 1
        ? `[SOURCE: OUTLOOK NOTIFICATION] A new email just arrived in Outlook. Details are in the previous message.`
        : `[SOURCE: OUTLOOK NOTIFICATION] ${newCount} new emails just arrived in Outlook. Details are in the previous messages.`;

      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for new Outlook notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

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
    logger.error('Outlook poll threw', { error: msg });
    recordFailure(msg);
  }
}

// ── Start/Stop ──

export function startOutlookWatcher(): void {
  if (pollTimer) {
    logger.warn('Outlook watcher already running');
    return;
  }

  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) {
    logger.info('Outlook watcher: Microsoft not connected, skipping');
    return;
  }

  const services = getEnabledMsServices();
  if (!services.outlook) {
    logger.info('Outlook watcher: Outlook service not enabled, skipping');
    return;
  }

  status.lastCheckedAt = loadLastCheckedAt();

  if (!status.lastCheckedAt) {
    status.lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(status.lastCheckedAt);
    logger.info('Outlook watcher: first run, seeded lastCheckedAt to now');
  }

  logger.info('Starting Outlook watcher', { pollInterval: POLL_INTERVAL_MS, lastCheckedAt: status.lastCheckedAt });

  pollTimer = setInterval(() => {
    pollForNewEmails().catch(err => {
      logger.error('Outlook poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  setTimeout(() => {
    pollForNewEmails().catch(() => { /* logged inside */ });
  }, 10_000);
}

export function stopOutlookWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Outlook watcher stopped');
  }
}

export function isOutlookWatcherRunning(): boolean {
  return pollTimer !== null;
}
