// ════════════════════════════════════════
// Teams Watcher: Polls for new incoming Teams messages and notifies the primary agent
// Mirrors the Outlook watcher but scans across all chats rather than one inbox
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { msGraphRead } from '../microsoft/client.js';
import { isMicrosoftEnabled, isMicrosoftConnected, getEnabledMsServices } from '../microsoft/auth.js';

const logger = createLogger('teams-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastCheckedAt: string | null = null;
let ownUserId: string | null = null;

const POLL_INTERVAL_MS = 120_000; // 2 minutes — tighter than email since Teams is conversational

// ── Persistence ──

function loadLastCheckedAt(): string | null {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM config WHERE key = 'teams_last_checked_at'").get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(timestamp: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES ('teams_last_checked_at', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(timestamp, timestamp);
  } catch (err) {
    logger.error('Failed to save teams_last_checked_at', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Own user ID (cached after first successful fetch) ──

async function getOwnUserId(): Promise<string | null> {
  if (ownUserId) return ownUserId;
  const result = await msGraphRead('me?$select=id', 'system', 'Teams Watcher', 'teams_watcher_me', {});
  if (!result.ok) return null;
  const me = result.data as { id?: string };
  ownUserId = me?.id ?? null;
  return ownUserId;
}

// ── Polling ──

async function pollForNewMessages(): Promise<void> {
  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) return;

  const services = getEnabledMsServices();
  if (!services.teams) return;

  try {
    const myId = await getOwnUserId();
    if (!myId) {
      logger.debug('Teams watcher: could not determine own user ID, skipping poll');
      return;
    }

    // Step 1: List all my chats, then filter to those updated since last check.
    // lastUpdatedDateTime on the chat object reflects the most recent message —
    // if it hasn't changed, there's nothing new to fetch.
    const chatsResult = await msGraphRead(
      'me/chats?$top=50&$select=id,topic,chatType,lastUpdatedDateTime',
      'system', 'Teams Watcher', 'teams_watcher_list_chats', {},
    );
    if (!chatsResult.ok) {
      logger.debug('Teams watcher: chat list error', { error: chatsResult.error });
      return;
    }

    const chatsData = chatsResult.data as {
      value?: Array<{ id: string; topic: string | null; chatType: string; lastUpdatedDateTime: string }>;
    };
    if (!chatsData?.value || chatsData.value.length === 0) {
      lastCheckedAt = new Date().toISOString();
      saveLastCheckedAt(lastCheckedAt);
      return;
    }

    const activeChats = lastCheckedAt
      ? chatsData.value.filter(c => c.lastUpdatedDateTime > lastCheckedAt!)
      : chatsData.value;

    if (activeChats.length === 0) {
      lastCheckedAt = new Date().toISOString();
      saveLastCheckedAt(lastCheckedAt);
      return;
    }

    const db = getDb();
    const primaryId = getPrimaryAgentId();

    const notifiedKey = 'teams_notified_ids';
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(notifiedKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    let newCount = 0;

    for (const chat of activeChats) {
      // Step 2: Fetch recent messages for each active chat.
      const msgsResult = await msGraphRead(
        `chats/${encodeURIComponent(chat.id)}/messages?$top=10&$orderby=createdDateTime desc`,
        'system', 'Teams Watcher', 'teams_watcher_messages', { chatId: chat.id },
      );
      if (!msgsResult.ok) {
        logger.debug('Teams watcher: messages fetch error', { chatId: chat.id, error: msgsResult.error });
        continue;
      }

      const msgsData = msgsResult.data as {
        value?: Array<{
          id: string;
          createdDateTime: string;
          from?: { user?: { id?: string; displayName?: string } };
          body?: { content: string; contentType: string };
          messageType?: string;
        }>;
      };
      if (!msgsData?.value) continue;

      for (const msg of msgsData.value) {
        // Only messages newer than our last check window
        if (lastCheckedAt && msg.createdDateTime <= lastCheckedAt) continue;
        // Skip own messages — we sent those
        if (msg.from?.user?.id === myId) continue;
        // Skip system events (member join/leave, topic changes, etc.)
        if (msg.messageType && msg.messageType !== 'message') continue;
        // Skip already-notified messages
        if (notifiedIds.has(msg.id)) continue;

        const senderName = msg.from?.user?.displayName ?? 'Someone';

        let body = msg.body?.content ?? '';
        if (msg.body?.contentType === 'html') {
          body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        body = body.slice(0, 1000);

        const chatLabel = chat.topic
          ? `"${chat.topic}"`
          : chat.chatType === 'oneOnOne'
            ? `1:1 chat with ${senderName}`
            : 'group chat';

        const content = [
          `[SOURCE: TEAMS NOTIFICATION — not a message from the user, this is an automated alert about a new incoming Teams message]`,
          ``,
          `From: ${senderName}`,
          `Chat: ${chatLabel} (${chat.chatType})`,
          `Time: ${msg.createdDateTime}`,
          ``,
          `Message:`,
          body,
          ``,
          `Chat ID: ${chat.id}`,
          `To reply, use teams_send_message with chat_id: ${chat.id}`,
        ].join('\n');

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

        logger.info('New Teams message notification sent to primary agent', {
          chatId: chat.id,
          sender: senderName,
          chatType: chat.chatType,
        });
      }
    }

    // Trigger the agent runtime once for all new messages
    if (newCount > 0) {
      const runtime = getAgentRuntime();
      const summary = newCount === 1
        ? `[SOURCE: TEAMS NOTIFICATION] A new Teams message just arrived. Details and the chat_id to reply with are in the previous message.`
        : `[SOURCE: TEAMS NOTIFICATION] ${newCount} new Teams messages just arrived. Details and chat_ids are in the previous messages.`;

      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for Teams notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Persist notified IDs — keep last 200 to avoid unbounded growth
    const recentIds = [...notifiedIds].slice(-200);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(notifiedKey, JSON.stringify(recentIds), JSON.stringify(recentIds));

    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);

  } catch (err) {
    logger.error('Teams poll cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Start / Stop ──

export function startTeamsWatcher(): void {
  if (pollTimer) {
    logger.warn('Teams watcher already running');
    return;
  }

  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) {
    logger.info('Teams watcher: Microsoft not connected, skipping');
    return;
  }

  const services = getEnabledMsServices();
  if (!services.teams) {
    logger.info('Teams watcher: Teams service not enabled, skipping');
    return;
  }

  lastCheckedAt = loadLastCheckedAt();

  // Seed to now on first run so we don't replay the entire chat history
  if (!lastCheckedAt) {
    lastCheckedAt = new Date().toISOString();
    saveLastCheckedAt(lastCheckedAt);
    logger.info('Teams watcher: first run, seeded lastCheckedAt to now');
  }

  logger.info('Starting Teams watcher', { pollInterval: POLL_INTERVAL_MS, lastCheckedAt });

  pollTimer = setInterval(() => {
    pollForNewMessages().catch(err => {
      logger.error('Teams poll interval failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after 15s — staggers after the Outlook watcher's 10s delay
  setTimeout(() => {
    pollForNewMessages().catch(() => {});
  }, 15_000);
}

export function stopTeamsWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Teams watcher stopped');
  }
}

export function isTeamsWatcherRunning(): boolean {
  return pollTimer !== null;
}
