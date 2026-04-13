// ════════════════════════════════════════
// Teams Watcher: Real-time-ish incoming Teams message notifications via delta queries
//
// Strategy:
//   - Poll chat list every 15 seconds to detect chats with new activity
//   - Use Graph delta queries (chats/{id}/messages/delta) so each call only returns
//     messages added since the previous call — no redundant fetches, no missed messages
//   - Delta tokens are persisted to DB so they survive server restarts
//   - New chats get a baseline delta token on first sight (no backlog replay)
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
let ownUserId: string | null = null;

// chatId → full delta link URL (persisted to DB)
const deltaTokens = new Map<string, string>();

// chatId → lastUpdatedDateTime from the most recent chat list poll (in-memory only)
// Used to skip delta calls for chats with no new activity
const chatLastUpdated = new Map<string, string>();

// userId → email (UPN) — populated when a chat's members are fetched on first sight
// Lets us include the sender's email in notifications without a per-message lookup
const userEmails = new Map<string, string>();

const POLL_INTERVAL_MS = 15_000;
const DELTA_TOKENS_KEY = 'teams_delta_tokens';

// ── Persistence ──

function loadDeltaTokens(): void {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(DELTA_TOKENS_KEY) as { value: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Record<string, string>;
      for (const [chatId, link] of Object.entries(parsed)) {
        deltaTokens.set(chatId, link);
      }
    }
  } catch {
    // start fresh
  }
}

function saveDeltaTokens(): void {
  try {
    const db = getDb();
    const obj = Object.fromEntries(deltaTokens);
    const json = JSON.stringify(obj);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(DELTA_TOKENS_KEY, json, json);
  } catch (err) {
    logger.error('Failed to persist Teams delta tokens', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Own user ID (cached) ──

async function getOwnUserId(): Promise<string | null> {
  if (ownUserId) return ownUserId;
  const result = await msGraphRead('me?$select=id', 'system', 'Teams Watcher', 'teams_watcher_me', {});
  if (!result.ok) return null;
  const me = result.data as { id?: string };
  ownUserId = me?.id ?? null;
  return ownUserId;
}

// ── Fetch chat members to build userId → email lookup ──
// Called once per chat during baseline initialization.
// Teams message payloads include displayName + userId but not email —
// we get emails from the chat member list instead.

async function fetchChatMembers(chatId: string): Promise<void> {
  const result = await msGraphRead(
    `chats/${encodeURIComponent(chatId)}/members?$select=userId,displayName,email`,
    'system', 'Teams Watcher', 'teams_watcher_members', { chatId },
  );
  if (!result.ok) return;

  const data = result.data as {
    value?: Array<{ userId?: string; displayName?: string; email?: string }>;
  };
  if (!data?.value) return;

  for (const member of data.value) {
    if (member.userId && member.email) {
      userEmails.set(member.userId, member.email);
    }
  }
}

// ── Delta query for a single chat ──
// Returns the number of new messages processed.
// If isBaseline=true, fetches the initial token only — no notifications sent.

async function pollChatDelta(
  chatId: string,
  chatTopic: string | null,
  chatType: string,
  isBaseline: boolean,
  myId: string,
  db: ReturnType<typeof getDb>,
  primaryId: string,
  notifiedIds: Set<string>,
): Promise<{ newCount: number; deltaLink: string | null }> {
  const storedLink = deltaTokens.get(chatId);
  const endpoint = storedLink ?? `chats/${encodeURIComponent(chatId)}/messages/delta?$top=20`;

  const result = await msGraphRead(endpoint, 'system', 'Teams Watcher', 'teams_watcher_delta', { chatId });

  if (!result.ok) {
    // 410 Gone = expired token; clear it so next poll reinitializes
    if (result.error?.includes('410') || result.error?.toLowerCase().includes('gone') || result.error?.toLowerCase().includes('sync state')) {
      logger.warn('Teams delta token expired, will reinitialize on next poll', { chatId });
      deltaTokens.delete(chatId);
      saveDeltaTokens();
    } else {
      logger.debug('Teams delta error', { chatId, error: result.error });
    }
    return { newCount: 0, deltaLink: null };
  }

  const data = result.data as Record<string, unknown>;

  // Extract the new delta link from the response
  const newDeltaLink = (data['@odata.deltaLink'] as string | undefined) ?? null;

  if (isBaseline) {
    // First time seeing this chat — just capture the token, don't notify
    return { newCount: 0, deltaLink: newDeltaLink };
  }

  const messages = (data.value as Array<{
    id: string;
    createdDateTime: string;
    from?: { user?: { id?: string; displayName?: string } };
    body?: { content: string; contentType: string };
    messageType?: string;
  }>) ?? [];

  let newCount = 0;

  for (const msg of messages) {
    if (msg.from?.user?.id === myId) continue;                      // skip own messages
    if (msg.messageType && msg.messageType !== 'message') continue;  // skip system events
    if (notifiedIds.has(msg.id)) continue;                          // deduplicate

    const senderId = msg.from?.user?.id ?? '';
    const senderName = msg.from?.user?.displayName ?? 'Someone';
    const senderEmail = senderId ? (userEmails.get(senderId) ?? null) : null;
    const senderLabel = senderEmail ? `${senderName} (${senderEmail})` : senderName;

    let body = msg.body?.content ?? '';
    if (msg.body?.contentType === 'html') {
      body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    body = body.slice(0, 1000);

    const chatLabel = chatTopic
      ? `"${chatTopic}"`
      : chatType === 'oneOnOne'
        ? `1:1 chat with ${senderName}`
        : 'group chat';

    const content = [
      `[SOURCE: TEAMS MESSAGE FROM ${senderLabel}]`,
      ``,
      `This is an incoming Microsoft Teams message — NOT a message from the dashboard user.`,
      `To reply, call teams_send_message with the chat_id shown below.`,
      ``,
      `Chat: ${chatLabel} (${chatType})`,
      `Time: ${msg.createdDateTime}`,
      ``,
      `Message:`,
      body,
      ``,
      `Chat ID: ${chatId}`,
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
      chatId,
      sender: senderName,
      chatType,
    });
  }

  return { newCount, deltaLink: newDeltaLink };
}

// ── Main poll ──

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

    // Get all chats with their last-updated timestamp
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
    if (!chatsData?.value) return;

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

    let totalNewCount = 0;
    let tokensChanged = false;

    for (const chat of chatsData.value) {
      const prevUpdated = chatLastUpdated.get(chat.id);
      const hasNewActivity = prevUpdated === undefined || chat.lastUpdatedDateTime !== prevUpdated;
      const isNewChat = !deltaTokens.has(chat.id);

      // Update our in-memory record of when this chat was last active
      chatLastUpdated.set(chat.id, chat.lastUpdatedDateTime);

      if (isNewChat) {
        // First time seeing this chat — fetch members to build userId→email lookup,
        // then initialize the delta token. No notifications on first sight.
        await fetchChatMembers(chat.id);
        const { deltaLink } = await pollChatDelta(
          chat.id, chat.topic, chat.chatType, true, myId, db, primaryId, notifiedIds,
        );
        if (deltaLink) {
          deltaTokens.set(chat.id, deltaLink);
          tokensChanged = true;
        }
        continue;
      }

      if (!hasNewActivity) {
        // No change since last poll — skip the delta call entirely
        continue;
      }

      // Chat has new activity — call delta to get only new messages
      const { newCount, deltaLink } = await pollChatDelta(
        chat.id, chat.topic, chat.chatType, false, myId, db, primaryId, notifiedIds,
      );

      totalNewCount += newCount;

      if (deltaLink) {
        deltaTokens.set(chat.id, deltaLink);
        tokensChanged = true;
      }
    }

    // Trigger the agent once for all new messages this poll
    if (totalNewCount > 0) {
      const runtime = getAgentRuntime();
      const summary = totalNewCount === 1
        ? `[SOURCE: TEAMS MESSAGE] An incoming Teams message is waiting above — review it and reply using teams_send_message with the chat_id provided.`
        : `[SOURCE: TEAMS MESSAGE] ${totalNewCount} incoming Teams messages are waiting above — review each one and reply using teams_send_message with the chat_id provided in each.`;

      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for Teams notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Persist delta tokens only when they changed
    if (tokensChanged) saveDeltaTokens();

    // Persist notified IDs (keep last 200)
    if (totalNewCount > 0) {
      const recentIds = [...notifiedIds].slice(-200);
      db.prepare(`
        INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(notifiedKey, JSON.stringify(recentIds), JSON.stringify(recentIds));
    }

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

  loadDeltaTokens();
  logger.info('Starting Teams watcher', {
    pollInterval: POLL_INTERVAL_MS,
    knownChats: deltaTokens.size,
  });

  pollTimer = setInterval(() => {
    pollForNewMessages().catch(err => {
      logger.error('Teams poll interval failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after 15s — staggers behind Outlook watcher's 10s delay
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
