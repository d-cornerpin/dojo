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

const logger = createLogger('outlook-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastCheckedAt: string | null = null;

const POLL_INTERVAL_MS = 300_000; // Check every 5 minutes (same as Gmail)

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
  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) return;

  const services = getEnabledMsServices();
  if (!services.outlook) return;

  try {
    // Query for unread messages in inbox, newer than lastCheckedAt
    // Graph API filter: isRead eq false and receivedDateTime gt {iso}
    const filter = lastCheckedAt
      ? `isRead eq false and receivedDateTime gt ${lastCheckedAt}`
      : `isRead eq false`;
    const endpoint = `me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$top=10&$select=id,from,subject,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`;

    const result = await msGraphRead(endpoint, 'system', 'Outlook Watcher', 'outlook_inbox_poll', { filter });

    if (!result.ok) {
      logger.debug('Outlook poll returned error', { error: result.error });
      return;
    }

    const data = result.data as { value?: Array<{ id: string; from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; receivedDateTime?: string; bodyPreview?: string }> };
    if (!data?.value || data.value.length === 0) {
      lastCheckedAt = new Date().toISOString();
      saveLastCheckedAt(lastCheckedAt);
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

      // Skip messages from the agent's own account
      if (ownEmail && fromAddress.toLowerCase() === ownEmail.toLowerCase()) continue;

      // Inject notification into primary agent's conversation
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

      logger.info('New Outlook email notification sent to primary agent', {
        from,
        subject,
        messageId: msg.id,
      });
    }

    // Trigger the agent runtime if we sent any notifications
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

    // Persist notified IDs (keep last 200)
    const recentIds = [...notifiedIds].slice(-200);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(notifiedKey, JSON.stringify(recentIds), JSON.stringify(recentIds));

    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);
  } catch (err) {
    logger.error('Outlook poll failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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

  lastCheckedAt = loadLastCheckedAt();

  // Seed to now on first run so we don't process the entire inbox
  if (!lastCheckedAt) {
    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);
    logger.info('Outlook watcher: first run, seeded lastCheckedAt to now');
  }

  logger.info('Starting Outlook watcher', { pollInterval: POLL_INTERVAL_MS, lastCheckedAt });

  pollTimer = setInterval(() => {
    pollForNewEmails().catch(err => {
      logger.error('Outlook poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after 10s delay
  setTimeout(() => {
    pollForNewEmails().catch(() => {});
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
