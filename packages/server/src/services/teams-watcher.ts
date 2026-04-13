// ════════════════════════════════════════
// Teams Watcher: Polls for new incoming Teams messages and notifies the primary agent
//
// Strategy:
//   - Every 15 seconds, fetch the chat list and filter to chats updated since last poll
//   - For each active chat, fetch recent messages and filter by timestamp client-side
//   - Graph delta queries are NOT supported for chatMessage — use timestamp filtering instead
//   - Per-chat member list is fetched once on first sight (no $select — userId is on the
//     derived aadUserConversationMember type, not the base conversationMember type)
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

// chatId → ISO timestamp of the newest message we processed from that chat
// Used to filter out already-seen messages on the next fetch
const chatLastMessageAt = new Map<string, string>();

// When the watcher started — used as the initial baseline for all chats
// so we don't replay messages that arrived before we were watching
let watcherStartedAt = new Date(0).toISOString();

// userId → email populated from chat member list on first sight of each chat
const userEmails = new Map<string, string>();

// chatId → true once we have fetched members (avoid re-fetching every poll)
const membersFetched = new Set<string>();

const POLL_INTERVAL_MS = 15_000;

// ── Own user ID (cached) ──

async function getOwnUserId(): Promise<string | null> {
  if (ownUserId) return ownUserId;
  const result = await msGraphRead('me?$select=id', 'system', 'Teams Watcher', 'teams_watcher_me', {});
  if (!result.ok) return null;
  const me = result.data as { id?: string };
  ownUserId = me?.id ?? null;
  return ownUserId;
}

// ── Fetch chat members to build userId → email map ──
// No $select — userId and email are on aadUserConversationMember (derived type),
// not conversationMember (base type), so $select on base fields rejects them.

async function fetchChatMembers(chatId: string): Promise<void> {
  if (membersFetched.has(chatId)) return;

  const result = await msGraphRead(
    `chats/${encodeURIComponent(chatId)}/members`,
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

  membersFetched.add(chatId);
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

    // Step 1: Get all chats with their last-updated timestamp
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

    // Fetch members + messages for all chats in parallel
    type ChatMessage = {
      id: string;
      createdDateTime: string;
      from?: { user?: { id?: string; displayName?: string } };
      body?: { content: string; contentType: string };
      messageType?: string;
    };

    const chatResults = await Promise.all(
      chatsData.value.map(async (chat) => {
        await fetchChatMembers(chat.id);
        const msgsResult = await msGraphRead(
          `chats/${encodeURIComponent(chat.id)}/messages?$top=10&$orderby=createdDateTime desc`,
          'system', 'Teams Watcher', 'teams_watcher_messages', { chatId: chat.id },
        );
        return { chat, msgsResult };
      }),
    );

    for (const { chat, msgsResult } of chatResults) {
      if (!msgsResult.ok) {
        logger.debug('Teams watcher: messages fetch error', { chatId: chat.id, error: msgsResult.error });
        continue;
      }

      const msgsData = msgsResult.data as { value?: ChatMessage[] };
      if (!msgsData?.value) continue;

      // For chats we've never processed before, use watcherStartedAt as baseline
      // so we don't replay messages that existed before the watcher came up
      const lastSeenAt = chatLastMessageAt.get(chat.id) ?? watcherStartedAt;
      let newestMessageAt = lastSeenAt;

      for (const msg of msgsData.value) {
        if (msg.createdDateTime <= lastSeenAt) continue;          // already seen
        if (msg.from?.user?.id === myId) continue;                // own message
        if (msg.messageType && msg.messageType !== 'message') continue; // system events
        if (notifiedIds.has(msg.id)) continue;                    // deduplicate

        // Track newest message timestamp to advance the window
        if (msg.createdDateTime > newestMessageAt) {
          newestMessageAt = msg.createdDateTime;
        }

        const senderId = msg.from?.user?.id ?? '';
        const senderName = msg.from?.user?.displayName ?? 'Someone';
        const senderEmail = senderId ? (userEmails.get(senderId) ?? null) : null;
        const senderLabel = senderEmail ? `${senderName} (${senderEmail})` : senderName;

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
          `[SOURCE: TEAMS MESSAGE FROM ${senderLabel}]`,
          ``,
          `This is an incoming Microsoft Teams message — NOT a message from the dashboard user.`,
          `To reply, call teams_send_message with the chat_id shown below.`,
          ``,
          `Chat: ${chatLabel} (${chat.chatType})`,
          `Time: ${msg.createdDateTime}`,
          ``,
          `Message:`,
          body,
          ``,
          `Chat ID: ${chat.id}`,
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
        totalNewCount++;

        logger.info('New Teams message notification sent to primary agent', {
          chatId: chat.id,
          sender: senderLabel,
          chatType: chat.chatType,
        });
      }

      // Advance the per-chat message window so we don't re-process these
      chatLastMessageAt.set(chat.id, newestMessageAt);
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

      // Persist notified IDs (keep last 200)
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

  watcherStartedAt = new Date().toISOString();
  logger.info('Starting Teams watcher', { pollInterval: POLL_INTERVAL_MS, watcherStartedAt });

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
    chatLastMessageAt.clear();
    membersFetched.clear();
    logger.info('Teams watcher stopped');
  }
}

export function isTeamsWatcherRunning(): boolean {
  return pollTimer !== null;
}
