// Teams watcher: polls for new incoming Teams messages and notifies the primary agent every 15 seconds.
//   - Fetch the chat list with each chat's newest message time, read only chats newer than their saved cursor
//     (all cursors live in one config row) and filter by timestamp client-side (Graph delta queries are NOT
//     supported for chatMessage).
//   - Each chat's member list is fetched once on first sight, with no $select: userId lives on the derived
//     aadUserConversationMember type, not the base conversationMember type.

import { v4 as uuidv4 } from 'uuid';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertInboundMessageIfAbsent } from '../work/ask-title.js';
import { isSenderAuthorized } from '../agent/v2/channel-auth.js';
import { senderWakes } from './channel-safe-senders.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { msGraphRead } from '../microsoft/client.js';
import { teamsInboundContent } from '../tools/inbound-fences.js';
import { isMicrosoftEnabled, isMicrosoftConnected, getEnabledMsServices } from '../microsoft/auth.js';
import { getPrimaryMicrosoftAccount } from '../microsoft/accounts.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError, watcherFailingOnRecord } from './watcher-status.js';

const logger = createLogger('teams-watcher');

// ── Status state ──
const status: WatcherStatus = {
  name: 'teams',
  running: false,
  enabled: false,
  connected: false,
  pollIntervalMs: 15_000, // overwritten below from POLL_INTERVAL_MS
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

export function getTeamsWatcherStatus(): WatcherStatus {
  status.enabled = isMicrosoftEnabled() && getEnabledMsServices().teams;
  status.connected = isMicrosoftConnected();
  status.running = pollTimer !== null;
  return { ...status, recentNotifications: [...status.recentNotifications] };
}

function recordPollSuccess(): void {
  status.lastPollAt = new Date().toISOString();
  status.lastPollOk = true;
  status.lastPollError = null;
  status.consecutiveFailures = 0;
  status.firstFailureAt = null;
  if (alreadyAlerted || watcherFailingOnRecord('teams')) {
    logger.info('Teams watcher recovered — sending recovery alert');
    alreadyAlerted = maybeAlertOnRecovery({
      name: 'teams', alreadyAlerted, totalNotificationsSinceFailure: notificationsSinceFailureAlert,
    });
    notificationsSinceFailureAlert = 0;
  }
}

function recordPollFailure(rawMsg: string): void {
  const msg = normalizeError(rawMsg);
  const nowIso = new Date().toISOString();
  status.lastPollAt = nowIso;
  status.lastPollOk = false;
  status.lastPollError = msg;
  status.consecutiveFailures++;
  if (!status.firstFailureAt) status.firstFailureAt = nowIso;
  alreadyAlerted = maybeAlertOnFailure({
    name: 'teams',
    consecutiveFailures: status.consecutiveFailures,
    firstFailureAt: status.firstFailureAt,
    lastError: msg,
    alreadyAlerted,
  });
}

function recordPollSkip(reason: string): void {
  status.lastPollAt = new Date().toISOString();
  status.lastPollOk = null;
  status.lastPollError = reason;
}

function recordNotification(n: RecentNotification): void {
  status.totalNotifications++;
  if (alreadyAlerted) notificationsSinceFailureAlert++;
  status.lastNotifiedAt = n.at;
  status.recentNotifications = pushRecent(status.recentNotifications, n);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let firstPollTimer: ReturnType<typeof setTimeout> | null = null;
let ownUserId: string | null = null;

// One saved time per chat (its newest message handled) and the start of the last good poll, the baseline for a chat
// not seen yet. Kept in one config row, so a message sent while the Dojo restarts is read after it.
const CURSORS_KEY = 'teams_chat_cursors';
interface TeamsCursors { since: string; chats: Record<string, string> }
let cursors: TeamsCursors = { since: new Date(0).toISOString(), chats: {} };

function loadCursors(): TeamsCursors | null {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(CURSORS_KEY) as { value: string } | undefined;
    const c = row ? JSON.parse(row.value) as Partial<TeamsCursors> : null;
    return c && typeof c.since === 'string' && c.chats && typeof c.chats === 'object' ? { since: c.since, chats: c.chats } : null;
  } catch { return null; }
}

// userId → email populated from chat member list on first sight of each chat
const userEmails = new Map<string, string>();

// chatId → true once we have fetched members (avoid re-fetching every poll)
const membersFetched = new Set<string>();

const POLL_INTERVAL_MS = 15_000;
const TEAMS_BODY_MAX = 4_000;   // a longer message is cut here and says so

// ── Own user ID (cached) ──

async function getOwnUserId(accountId: string): Promise<string | null> {
  if (ownUserId) return ownUserId;
  const result = await msGraphRead('me?$select=id', 'system', 'Teams Watcher', 'teams_watcher_me', {}, accountId);
  if (!result.ok) return null;
  const me = result.data as { id?: string };
  ownUserId = me?.id ?? null;
  return ownUserId;
}

// ── Fetch chat members to build userId → email map ──
// No $select: userId and email are on the derived aadUserConversationMember type, so base-field $select rejects them.

async function fetchChatMembers(chatId: string, accountId: string): Promise<void> {
  if (membersFetched.has(chatId)) return;

  const result = await msGraphRead(
    `chats/${encodeURIComponent(chatId)}/members`,
    'system', 'Teams Watcher', 'teams_watcher_members', { chatId }, accountId,
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
  status.totalPolls++;
  if (!isMicrosoftEnabled() || !isMicrosoftConnected()) {
    recordPollSkip(!isMicrosoftEnabled() ? 'Microsoft integration disabled in Settings' : 'Microsoft not connected — re-auth in Settings');
    return;
  }

  const services = getEnabledMsServices();
  if (!services.teams) {
    recordPollSkip('Teams service disabled in Settings → Channels (the Microsoft cards)');
    return;
  }

  // The watched account is the agent's first Microsoft account, the one the checks above read.
  const accountId = getPrimaryMicrosoftAccount('agent')?.id;
  if (!accountId) {
    recordPollSkip('Microsoft not connected. Sign in again in Settings → Channels (the Microsoft cards).');
    return;
  }

  try {
    const myId = await getOwnUserId(accountId);
    if (!myId) {
      logger.warn('Teams watcher: could not determine own user ID, skipping poll');
      recordPollFailure('Could not determine own user ID');
      return;
    }
    const pollStartIso = new Date().toISOString();

    // Step 1: Get the chats, newest activity first, each with the time of its newest message
    const chatsResult = await msGraphRead(
      'me/chats?$top=50&$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc',
      'system', 'Teams Watcher', 'teams_watcher_list_chats', {}, accountId,
    );
    if (!chatsResult.ok) {
      logger.warn('Teams watcher: chat list error', { error: chatsResult.error });
      recordPollFailure(chatsResult.error ?? 'Chat list error');
      return;
    }

    const chatsData = chatsResult.data as {
      value?: Array<{ id: string; topic: string | null; chatType: string; lastMessagePreview?: { createdDateTime?: string } | null }>;
    };
    if (!chatsData?.value) {
      // No chats is not an error; still record success so the status panel does not go stale.
      recordPollSuccess();
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

    let totalNewCount = 0;
    let wakeCount = 0;

    // Fetch members + messages for all chats in parallel
    type ChatMessage = {
      id: string;
      createdDateTime: string;
      from?: { user?: { id?: string; displayName?: string } };
      body?: { content: string; contentType: string };
      messageType?: string;
      attachments?: Array<{ name?: string | null }>;
    };

    // Only chats whose newest message is newer than what was handled are read; a chat with no preview is read.
    const moved = chatsData.value.filter((chat) => {
      const newest = chat.lastMessagePreview?.createdDateTime;
      return !newest || newest > (cursors.chats[chat.id] ?? cursors.since);
    });

    const chatResults = await Promise.all(
      moved.map(async (chat) => {
        await fetchChatMembers(chat.id, accountId);
        const msgsResult = await msGraphRead(
          `chats/${encodeURIComponent(chat.id)}/messages?$top=10&$orderby=createdDateTime desc`,
          'system', 'Teams Watcher', 'teams_watcher_messages', { chatId: chat.id }, accountId,
        );
        return { chat, msgsResult };
      }),
    );

    for (const { chat, msgsResult } of chatResults) {
      // A chat seen for the first time keeps the current baseline, so a failed read is tried again from it.
      const lastSeenAt = cursors.chats[chat.id] ?? cursors.since;
      cursors.chats[chat.id] = lastSeenAt;
      if (!msgsResult.ok) {
        logger.debug('Teams watcher: messages fetch error', { chatId: chat.id, error: msgsResult.error });
        continue;
      }

      const msgsData = msgsResult.data as { value?: ChatMessage[] };
      if (!msgsData?.value) continue;

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
        // A long message says where it was cut, and attached files are named, so the agent knows what it has not seen.
        if (body.length > TEAMS_BODY_MAX) body = `${body.slice(0, TEAMS_BODY_MAX)}\n[The message is longer than 4,000 characters and was cut here.]`;
        const files = (msg.attachments ?? []).map((a) => a.name).filter((n): n is string => !!n);
        if (files.length > 0) body += `\n[Attached files: ${files.join(', ')}]`;

        // He and the people on the Teams approved list wake the agent; anyone else waits for its next turn.
        const wakes = senderWakes('teams', null, senderEmail ?? '');
        const content = teamsInboundContent({ senderEmail, senderName, chatTopic: chat.topic ?? null, chatType: chat.chatType, time: msg.createdDateTime, body, chatId: chat.id, replyInGroup: wakes && chat.chatType !== 'oneOnOne' });

        const msgId = uuidv4();
        // Conversation identity is the Teams chat id.
        const conversationId = resolveOrCreateConversation(primaryId, {
          channel: 'teams', provider: 'teams', counterpartyId: senderEmail ?? senderName ?? null,
          counterpartyName: senderName ?? null, threadRoot: chat.id ?? null,
        });
        // Structured routing metadata. Teams is an agent-kind channel, so the shared auth check applies the
        // agent-kind gate: an unknown sender is authorized:false and read as a notification, not auto-replied.
        // Anything that is NOT a 1:1 is classified 'group' (Graph 'meeting' chats included), so a multi-party
        // message is authorized:false: deriveOrigin classifies it as a non-auto-reply notice and
        // getWaitingHumanConversations does not make it a mandatory waiting turn. It still reaches the model
        // via the EVENTS lane, and the agent may reply into the group with an explicit teams_send_message.
        const isDm = chat.chatType === 'oneOnOne';
        const inboundMetaObj = {
          channel: 'teams' as const,
          accountKind: 'agent' as const,
          authorized: isDm && isSenderAuthorized('teams', senderEmail, 'agent'),
          sender: senderEmail,
          senderName,   // the badge's name; the model reads it inside the fence only
          chatId: chat.id,
          chatType: (isDm ? 'dm' : 'group') as 'dm' | 'group',
          recipientAddress: senderEmail ?? undefined,
        };
        // Channel, sender and the group/DM auth verdict are stamped in the write from this watcher's own meta,
        // never re-derived; `insertInboundMessageIfAbsent` keeps the external_message_id de-duplication.
        insertInboundMessageIfAbsent({
          id: msgId,
          agentId: primaryId,
          role: 'user',
          content,
          conversationId,
          externalMessageId: (msg as { id?: string | null }).id ?? null,
          channel: inboundMetaObj.channel,
          senderId: inboundMetaObj.sender,
          authorized: inboundMetaObj.authorized,
        });
        recordInboundMeta(msgId, inboundMetaObj);

        broadcast({
          type: 'chat:message',
          agentId: primaryId,
          message: {
            id: msgId,
            agentId: primaryId,
            role: 'user' as const,
            content,
            // The same structured inbound_meta and conversation binding as the DB row, so ws.ts
            // stampChatMessageOrigin derives identical attribution live and on refetch. Load-bearing: a
            // group/meeting message is authorized:false, so without it the live marker-parse fallback would
            // render it while refetch hides it.
            conversationId,
            inboundMeta: JSON.stringify(inboundMetaObj),
            tokenCount: null,
            modelId: null,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });

        notifiedIds.add(msg.id);
        totalNewCount++;
        if (wakes) wakeCount++;
        recordNotification({
          at: new Date().toISOString(),
          from: senderLabel,
          subject: chat.topic ?? `${chat.chatType} chat`,
        });

        logger.info('New Teams message notification sent to primary agent', {
          chatId: chat.id,
          sender: senderLabel,
          chatType: chat.chatType,
        });
      }

      // Advance the per-chat window past what was read, including his own newest message or a system event, so a quiet chat is not read again.
      const previewAt = chat.lastMessagePreview?.createdDateTime;
      cursors.chats[chat.id] = previewAt && previewAt > newestMessageAt ? previewAt : newestMessageAt;
    }

    if (totalNewCount > 0) {
      // Persist notified IDs (last 200)
      const recentIds = [...notifiedIds].slice(-200);
      setConfigValue(notifiedKey, JSON.stringify(recentIds));
    }

    // Wake the agent once for the new messages from him or approved senders; the rest wait for its next turn.
    if (wakeCount > 0) {
      const summary = wakeCount === 1
        ? '[SOURCE: TEAMS MESSAGE] New Teams message. Details above: act on it as the framing there indicates.'
        : `[SOURCE: TEAMS MESSAGE] ${wakeCount} new Teams messages. Details above: act on each as the framing there indicates.`;
      getAgentRuntime().handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for Teams notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    cursors.since = pollStartIso;
    setConfigValue(CURSORS_KEY, JSON.stringify(cursors));

    recordPollSuccess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Teams poll cycle failed', { error: msg });
    recordPollFailure(msg);
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

  cursors = loadCursors() ?? { since: new Date().toISOString(), chats: {} };
  logger.info('Starting Teams watcher', { pollInterval: POLL_INTERVAL_MS, since: cursors.since });

  pollTimer = setInterval(() => {
    pollForNewMessages().catch(err => {
      logger.error('Teams poll interval failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  // Initial poll after 15s, staggered behind the Outlook watcher's 10s delay
  firstPollTimer = setTimeout(() => {
    pollForNewMessages().catch(() => {});
  }, 15_000);
}

export function stopTeamsWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (firstPollTimer) {
      clearTimeout(firstPollTimer);
      firstPollTimer = null;
    }
    membersFetched.clear();
    ownUserId = null;
    userEmails.clear();
    logger.info('Teams watcher stopped');
  }
}
