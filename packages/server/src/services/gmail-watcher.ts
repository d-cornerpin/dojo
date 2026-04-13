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

const logger = createLogger('gmail-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastCheckedAt: string | null = null;

const POLL_INTERVAL_MS = 300_000; // Check every 5 minutes

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
  if (!isGoogleEnabled() || !isGoogleConnected()) return;

  const services = getEnabledServices();
  if (!services.gmail) return;

  try {
    // Build query: unread emails newer than last check
    let query = 'is:unread in:inbox';
    if (lastCheckedAt) {
      // Gmail search uses after: with date format YYYY/MM/DD
      const afterDate = new Date(lastCheckedAt);
      const dateStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;
      query += ` after:${dateStr}`;
    }

    const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=10`;
    const result = await googleRead(listUrl, 'system', 'Gmail Watcher', 'gmail_inbox_poll', { query });

    if (!result.ok) {
      // Don't log on every poll failure — could be transient
      logger.debug('Gmail poll returned no results or error', { error: result.error });
      return;
    }

    const data = result.data as { messages?: Array<{ id: string; threadId: string }> };
    if (!data?.messages || data.messages.length === 0) {
      // No new messages, update timestamp
      lastCheckedAt = new Date().toISOString();
      saveLastCheckedAt(lastCheckedAt);
      return;
    }

    // Fetch metadata for each new message
    const db = getDb();
    const primaryId = getPrimaryAgentId();
    const ownerName = getOwnerName();

    // Track which message IDs we've already notified about (avoid duplicates across polls)
    const notifiedKey = 'gmail_notified_ids';
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(notifiedKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    let newCount = 0;

    for (const msg of data.messages) {
      if (notifiedIds.has(msg.id)) continue;

      // Fetch message metadata
      const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
      const detail = await googleRead(detailUrl, 'system', 'Gmail Watcher', 'gmail_read', { messageId: msg.id });

      if (!detail.ok) continue;

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

      // Don't notify about emails from the agent's own account
      const ownEmail = (() => {
        try {
          const row = db.prepare("SELECT value FROM config WHERE key = 'gws_account_email'").get() as { value: string } | undefined;
          return row?.value ?? null;
        } catch { return null; }
      })();
      if (ownEmail && from.includes(ownEmail)) continue;

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

      logger.info('New email notification sent to primary agent', {
        from,
        subject,
        messageId: msg.id,
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

    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);
  } catch (err) {
    logger.error('Gmail poll failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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

  lastCheckedAt = loadLastCheckedAt();

  // If first run, seed to now so we don't process the entire inbox
  if (!lastCheckedAt) {
    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);
    logger.info('Gmail watcher: first run, seeded lastCheckedAt to now');
  }

  logger.info('Starting Gmail watcher', { pollInterval: POLL_INTERVAL_MS, lastCheckedAt });

  pollTimer = setInterval(() => {
    pollForNewEmails().catch(err => {
      logger.error('Gmail poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after a short delay (let the server finish starting)
  setTimeout(() => {
    pollForNewEmails().catch(() => {});
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
