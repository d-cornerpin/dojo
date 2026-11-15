// Gmail watcher: polls each connected ACCOUNT's inbox (up to 5 agent + 5 user) independently and notifies the
// primary agent; each account has its own watch toggle, cursor, notifiedIds dedup set and failure state, so a flaky
// account does not suppress the others. WatcherStatus is an aggregate: `connected`/`enabled` are true if ANY
// monitored account satisfies them, counters sum, and account-level errors go to logs.

import { v4 as uuidv4 } from 'uuid';
import { resolveOrCreateConversation } from '../memory/conversations.js';
import { getDb } from '../db/connection.js';
import { recordInboundMeta } from '../agent/v2/inbound-channel.js';
import { insertInboundMessageIfAbsent } from '../work/ask-title.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { googleRead } from '../google/client.js';
import { GMAIL_BASE } from '../google/gmail-search.js';
import { listGoogleAccountViews, type GoogleAccountView } from '../google/auth.js';
import { getGmailSafeSenders } from './channel-safe-senders.js';
import { addressesMatch } from './imessage-bridge.js';
import { listAgentSelfIdentities, matchSelfIdentity } from './self-identities.js';
import { gmailAddressingFacts, gmailSnippetText } from './mail-inbound-facts.js';
import { persistNotifiedIds } from './notified-ids.js';
import { judgeGmailOwnerEmail, ownerEmailCommandNote } from './mail-owner-intake.js';
import { mailNoticeContent } from '../tools/inbound-fences.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError, watcherFailingOnRecord, watchedForMail } from './watcher-status.js';

const logger = createLogger('gmail-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;
let firstPollTimer: ReturnType<typeof setTimeout> | null = null;

const POLL_INTERVAL_MS = 300_000;
const MAX_RESULTS_PER_POLL = 50;
const LOOKBACK_MARGIN_MS = 15 * 60 * 1000;

// ── Per-account transient state ──
//
// One block per connected account so a stuck token on one mailbox cannot suppress alerting for the others;
// lastCheckedAt is mirrored from the DB on startup and the in-memory copy is the truth at runtime.
interface AccountWatchState {
  lastCheckedAt: string | null;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastPollError: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  totalPolls: number;
  totalNotifications: number;
  lastNotifiedAt: string | null;
  recentNotifications: RecentNotification[];
  alreadyAlerted: boolean;
  notificationsSinceFailureAlert: number;
}

// Keyed by account id, created lazily so accounts added at runtime are polled without a restart.
const accountState = new Map<string, AccountWatchState>();

function stateFor(accountId: string): AccountWatchState {
  let s = accountState.get(accountId);
  if (!s) {
    s = makeEmptyState();
    accountState.set(accountId, s);
  }
  return s;
}

function makeEmptyState(): AccountWatchState {
  return {
    lastCheckedAt: null,
    lastPollAt: null,
    lastPollOk: null,
    lastPollError: null,
    consecutiveFailures: 0,
    firstFailureAt: null,
    totalPolls: 0,
    totalNotifications: 0,
    lastNotifiedAt: null,
    recentNotifications: [],
    alreadyAlerted: false,
    notificationsSinceFailureAlert: 0,
  };
}

/** An account this watcher should be monitoring right now. */
function isMonitored(v: GoogleAccountView): boolean {
  return v.connected && watchedForMail(v, 'gmail');
}

// ── Aggregated status (single-row view for dashboard Health panel) ──

export function getGmailWatcherStatus(): WatcherStatus {
  const views = listGoogleAccountViews();
  const entries = views.map(v => ({ view: v, state: stateFor(v.id) }));
  const monitored = views.filter(isMonitored);

  const enabled = monitored.length > 0;
  const connected = views.some(v => v.connected);
  const lastPollAt = pickLatest(entries.map(e => e.state.lastPollAt));
  const lastNotifiedAt = pickLatest(entries.map(e => e.state.lastNotifiedAt));
  const totalPolls = entries.reduce((a, e) => a + e.state.totalPolls, 0);
  const totalNotifications = entries.reduce((a, e) => a + e.state.totalNotifications, 0);
  const lastCheckedAt = pickLatest(entries.map(e => e.state.lastCheckedAt));

  // lastPollOk: false if any account's last poll failed; true if all succeeded;
  // null if none has polled yet OR all latest polls were skips.
  const ok = entries.map(e => e.state.lastPollOk).filter((v): v is boolean => v !== null);
  const lastPollOk: boolean | null = ok.length === 0 ? null : ok.every(v => v);
  const lastPollError = entries.find(e => e.state.lastPollOk === false)?.state.lastPollError ?? null;
  const consecutiveFailures = entries.reduce((a, e) => Math.max(a, e.state.consecutiveFailures), 0);
  const firstFailureAt = pickEarliest(entries.map(e => e.state.firstFailureAt).filter((v): v is string => v !== null));

  // Merge and re-sort recent notifications across accounts
  const merged: RecentNotification[] = entries
    .flatMap(e => e.state.recentNotifications)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);

  return {
    name: 'gmail',
    running: pollTimer !== null,
    enabled,
    connected,
    pollIntervalMs: POLL_INTERVAL_MS,
    lastPollAt,
    lastPollOk,
    lastPollError,
    consecutiveFailures,
    firstFailureAt,
    lastCheckedAt,
    totalPolls,
    totalNotifications,
    lastNotifiedAt,
    recentNotifications: merged,
  };
}

function pickLatest(times: Array<string | null>): string | null {
  const valid = times.filter((v): v is string => v !== null);
  if (valid.length === 0) return null;
  return valid.sort().slice(-1)[0];
}

function pickEarliest(times: string[]): string | null {
  if (times.length === 0) return null;
  return times.sort()[0];
}

// ── Per-account persistence ──
//
// The agent position-1 account keeps the original unprefixed keys (zero data movement for existing installs); every
// other account is suffixed by its id (the user position-1 row's id is literally 'user').

function lastCheckedKey(accountId: string): string {
  return accountId === 'agent' ? 'gmail_last_checked_at' : `gmail_last_checked_at_${accountId}`;
}

function notifiedKey(accountId: string): string {
  return accountId === 'agent' ? 'gmail_notified_ids' : `gmail_notified_ids_${accountId}`;
}

function loadLastCheckedAt(accountId: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(lastCheckedKey(accountId)) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(accountId: string, timestamp: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(lastCheckedKey(accountId), timestamp, timestamp);
  } catch (err) {
    logger.error('Failed to save gmail_last_checked_at', {
      accountId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Per-account polling ──

async function pollAccount(view: GoogleAccountView): Promise<void> {
  const accountId = view.id;
  const kind = view.kind;
  const s = stateFor(accountId);
  s.totalPolls++;
  const pollStartIso = new Date().toISOString();

  const recordSuccess = (): void => {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = true;
    s.lastPollError = null;
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
    if (s.alreadyAlerted || watcherFailingOnRecord('gmail', accountId)) {
      logger.info('Gmail watcher recovered — sending recovery alert', { accountId });
      s.alreadyAlerted = maybeAlertOnRecovery({
        name: 'gmail', accountId, alreadyAlerted: s.alreadyAlerted, totalNotificationsSinceFailure: s.notificationsSinceFailureAlert,
      });
      s.notificationsSinceFailureAlert = 0;
    }
  };
  const recordFailure = (rawMsg: string): void => {
    const msg = normalizeError(rawMsg);
    const nowIso = new Date().toISOString();
    s.lastPollAt = nowIso;
    s.lastPollOk = false;
    s.lastPollError = msg;
    s.consecutiveFailures++;
    if (!s.firstFailureAt) s.firstFailureAt = nowIso;
    s.alreadyAlerted = maybeAlertOnFailure({
      name: 'gmail', accountId,
      consecutiveFailures: s.consecutiveFailures,
      firstFailureAt: s.firstFailureAt,
      lastError: msg,
      alreadyAlerted: s.alreadyAlerted,
    });
  };

  // Per-account skip checks. Recorded as non-error skips so the aggregated
  // status can still surface "why is nothing happening" via lastPollError.
  const label = view.email ?? `${kind} account`;
  if (!view.enabled || !view.connected) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = !view.enabled ? `${label}: Google integration disabled` : `${label}: not connected`;
    return;
  }
  if (!view.watchEmail) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = `${label}: email monitoring disabled`;
    return;
  }
  if (!view.services.gmail) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = `${label}: Gmail service disabled`;
    return;
  }

  try {
    // First poll of a newly-monitored account: set the baseline to "now" and do not backfill; later polls query
    // `after:` it, so pre-existing mail is never notified.
    if (!s.lastCheckedAt) {
      s.lastCheckedAt = pollStartIso;
      saveLastCheckedAt(accountId, pollStartIso);
      recordSuccess();
      logger.info('Gmail watcher: baseline set for newly-monitored account, skipping inbox backfill', { accountId });
      return;
    }

    let query = 'in:inbox';
    if (s.lastCheckedAt) {
      const cursorMs = new Date(s.lastCheckedAt).getTime() - LOOKBACK_MARGIN_MS;
      const afterEpoch = Math.floor(Math.max(0, cursorMs) / 1000);
      query += ` after:${afterEpoch}`;
    }

    const listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${MAX_RESULTS_PER_POLL}`;
    const result = await googleRead(listUrl, 'system', 'Gmail Watcher', 'gmail_inbox_poll', { query, account: accountId }, accountId);

    if (!result.ok) {
      logger.warn('Gmail poll failed', { accountId, error: result.error, query });
      recordFailure(result.error ?? 'Unknown poll error');
      return;
    }

    const data = result.data as { messages?: Array<{ id: string; threadId: string }> };

    const db = getDb();
    const nKey = notifiedKey(accountId);
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(nKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    logger.info('Gmail poll: list returned', {
      accountId, query, count: data?.messages?.length ?? 0,
      lastCheckedAt: s.lastCheckedAt,
    });

    if (!data?.messages || data.messages.length === 0) {
      s.lastCheckedAt = pollStartIso;
      saveLastCheckedAt(accountId, pollStartIso);
      recordSuccess();
      return;
    }

    const primaryId = getPrimaryAgentId();

    // The account's own email goes in the notification body, with the read tool (gmail_read or user_gmail_read) and the
    // `account` param, so the agent picks the right mailbox.
    const accountEmail = view.email;
    const toolHint = kind === 'agent' ? 'gmail_read' : 'user_gmail_read';
    const notifyAccount = accountEmail ?? kind;
    const accountSuffix = kind === 'user' ? "user's Google account" : "agent's Google account";

    // Every agent-mailbox identity across both providers, resolved once per poll for the self-sent skip.
    const selfIdentities = listAgentSelfIdentities();

    let newCount = 0;

    for (const msg of data.messages) {
      if (notifiedIds.has(msg.id)) {
        logger.info('Gmail poll: skipping already-notified', { accountId, messageId: msg.id });
        continue;
      }

      const detailUrl = `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Authentication-Results&metadataHeaders=Message-ID&metadataHeaders=X-Platform-Send-Id`;
      const detail = await googleRead(detailUrl, 'system', 'Gmail Watcher', 'gmail_read', { messageId: msg.id, account: accountId }, accountId);

      if (!detail.ok) {
        logger.warn('Gmail message detail fetch failed', { accountId, messageId: msg.id, error: detail.error });
        continue;
      }

      const msgData = detail.data as {
        id: string;
        snippet: string;
        labelIds?: string[];
        payload?: { headers?: Array<{ name: string; value: string }> };
      };

      const headers = msgData?.payload?.headers ?? [];
      // Who the mail went to, where THIS mailbox sits (only its own address: the agent's other mailboxes do not make
      // this copy a To or Cc one, which the owner-mail blind-copy check reads), and the provider's Authentication-Results.
      const mailAddressing = gmailAddressingFacts(headers, accountEmail ? [accountEmail] : []);
      const from = headers.find(h => h.name === 'From')?.value ?? 'Unknown sender';
      const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
      const date = headers.find(h => h.name === 'Date')?.value ?? '';
      const snippet = gmailSnippetText(msgData?.snippet);
      const labelIds = msgData?.labelIds ?? [];

      // Parse the sender once: it is the decisive signal for the self-sent skip and the direct-message check.
      const fromAddr = (from.match(/<([^>]+)>/) ?? from.match(/(\S+@\S+)/))?.[1]?.toLowerCase() ?? '';

      // The agent's own outbound must never wake it (cost, reply loops). A label test cannot fire (the query is
      // `in:inbox` and self-addressed mail carries SENT and INBOX), so the decisive signal is the SENDER: not this
      // watched account nor any other agent-mailbox identity across both providers. User-kind mailboxes are excluded:
      // the owner mailing the agent must still wake it. The mail stays in the inbox; only the wake is suppressed.
      const hasSent = labelIds.includes('SENT');
      const selfIdentity = !fromAddr
        ? null
        : matchSelfIdentity(fromAddr, selfIdentities)
          ?? (accountEmail && addressesMatch(fromAddr, accountEmail) ? accountEmail : null);
      if (selfIdentity) {
        logger.info('Gmail poll: skipping self-sent', { accountId, messageId: msg.id, from, subject, hasSent, selfIdentity });
        notifiedIds.add(msg.id);
        continue;
      }
      logger.info('Gmail poll: notifying', { accountId, messageId: msg.id, from, subject });

      const { getOwnerName } = await import('../config/platform.js');
      const ownerName = getOwnerName();
      // Direct to the agent: only its own mailbox, from a safe sender (a user mailbox is the human's mail, never
      // answered for them) or the owner's own email the provider confirmed (`mail-owner-intake.ts`).
      const ownerMail = await judgeGmailOwnerEmail({ kind, placement: mailAddressing.placement, from, headers, messageId: msg.id, accountId });
      const ownerEmail = ownerMail.state === 'none' ? undefined : ownerMail;
      const isDirectToAgent = ownerMail.state === 'confirmed' || (kind === 'agent' && !!fromAddr
        && getGmailSafeSenders('agent').some(sndr => addressesMatch(sndr.address, fromAddr)));
      const content = mailNoticeContent({ provider: 'GMAIL', accountSuffix, account: notifyAccount, ownerName, kind, fromAddr, from, subject, date, snippet,
        messageId: msg.id, directToAgent: isDirectToAgent, toolHint, addressing: mailAddressing, ownerEmail }) + await ownerEmailCommandNote(ownerMail);

      const msgId = uuidv4();
      // Email conversation identity = provider + sender + THREAD, so two threads from one sender are different
      // conversations; msg.id stays the external identity.
      const conversationId = resolveOrCreateConversation(primaryId, {
        channel: 'email', provider: 'gmail', counterpartyId: fromAddr || from,
        threadRoot: (msg as { threadId?: string | null }).threadId ?? msg.id ?? null,
      });
      // Structured routing metadata so the engine auto-routes the reply off reliable data, not re-parsed prose:
      // isDirectToAgent encodes the auth verdict, and a user-kind mailbox or unknown sender is authorized:false, so the
      // agent reads it as a notification and never auto-replies for the human.
      const inboundMetaObj = {
        channel: 'email' as const,
        accountKind: kind,
        authorized: isDirectToAgent,
        sender: fromAddr || from,
        emailMessageId: msg.id,
        emailService: 'gmail' as const,
        emailAccount: notifyAccount,
        emailSubject: subject,
        mailAddressing,
        ...(ownerMail.state === 'confirmed' ? { relation: 'owner' as const, ownerWords: ownerMail.words, ownerWordsAt: Number((msgData as { internalDate?: string }).internalDate) } : {}),
      };
      // Channel, sender and the auth verdict are stamped IN the write, from the meta just computed, never re-derived;
      // recordInboundMeta below records the full blob. insertMessageIfAbsent keeps the external_message_id dedup.
      const stored = insertInboundMessageIfAbsent({
        id: msgId,
        agentId: primaryId,
        role: 'user',
        content,
        conversationId,
        externalMessageId: msg.id ?? null,
        channel: inboundMetaObj.channel,
        senderId: inboundMetaObj.sender,
        authorized: inboundMetaObj.authorized,
      });
      // null = the row landed on a poll whose processed-list save was lost; the live frame is for a first sighting
      // only, or the dashboard shows the same card twice.
      if (stored !== null) {
        recordInboundMeta(msgId, inboundMetaObj);

        broadcast({
          type: 'chat:message',
          agentId: primaryId,
          message: {
            id: msgId,
            agentId: primaryId,
            role: 'user' as const,
            content,
            // Carry the same structured inbound_meta into the live broadcast that the DB row holds, so ws.ts
            // stampChatMessageOrigin derives identical attribution live and on refetch, and the conversation binding the insert
            // used is on the wire too.
            conversationId,
            inboundMeta: JSON.stringify(inboundMetaObj),
            tokenCount: null,
            modelId: null,
            cost: null,
            latencyMs: null,
            createdAt: new Date().toISOString(),
          },
        });
      }

      notifiedIds.add(msg.id);
      persistNotifiedIds(nKey, notifiedIds);   // after each message, so a poll that throws later does not re-read it
      newCount++;
      s.totalNotifications++;
      if (s.alreadyAlerted) s.notificationsSinceFailureAlert++;
      s.lastNotifiedAt = new Date().toISOString();
      s.recentNotifications = pushRecent(s.recentNotifications, {
        at: s.lastNotifiedAt,
        from: `${from} → ${notifyAccount}`,
        subject,
      });
      logger.info('New email notification sent to primary agent', { accountId, from, subject, messageId: msg.id });
    }

    if (newCount > 0) {
      const runtime = getAgentRuntime();
      // Neutral trigger nudge: the per-email messages above carry the real framing, so this must not contradict them.
      const summary = newCount === 1
        ? `[SOURCE: GMAIL NOTIFICATION] New email in ${notifyAccount}. Details above — act on it as the framing there indicates.`
        : `[SOURCE: GMAIL NOTIFICATION] ${newCount} new emails in ${notifyAccount}. Details above — act on each as the framing there indicates.`;
      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for new email notification', {
          accountId, error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    persistNotifiedIds(nKey, notifiedIds);

    s.lastCheckedAt = pollStartIso;
    saveLastCheckedAt(accountId, pollStartIso);
    recordSuccess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Gmail poll threw', { accountId, error: msg });
    recordFailure(msg);
  }
}

async function pollAllAccounts(): Promise<void> {
  for (const view of listGoogleAccountViews()) {
    try {
      await pollAccount(view);
    } catch (err) {
      logger.error('Gmail pollAccount threw outside catch', {
        accountId: view.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Start/Stop ──

/**
 * Reset an account's watch cursor to "now" so only mail arriving from here on notifies (the inbox is never replayed).
 * Called when watch-email is toggled ON; the watcher bounce that follows re-hydrates the value from the DB.
 */
export function markGmailWatchBaselineNow(accountId: string): void {
  saveLastCheckedAt(accountId, new Date().toISOString());
}

export function startGmailWatcher(): void {
  if (pollTimer) {
    logger.warn('Gmail watcher already running');
    return;
  }

  // Hydrate per-account lastCheckedAt from the DB; a connected, monitored account that never polled is seeded to
  // "now" so a fresh mailbox does not replay history.
  const views = listGoogleAccountViews();
  for (const v of views) {
    const s = stateFor(v.id);
    s.lastCheckedAt = loadLastCheckedAt(v.id);
    if (!s.lastCheckedAt && v.connected && v.watchEmail) {
      const now = new Date().toISOString();
      s.lastCheckedAt = now;
      saveLastCheckedAt(v.id, now);
      logger.info('Gmail watcher: first run, seeded lastCheckedAt to now', { accountId: v.id });
    }
  }

  const monitored = views.filter(isMonitored);
  if (monitored.length === 0) {
    logger.info('Gmail watcher: no accounts have email monitoring enabled, skipping');
    return;
  }

  logger.info('Starting Gmail watcher', {
    pollInterval: POLL_INTERVAL_MS,
    monitoredAccounts: monitored.map(v => v.email ?? v.id),
  });

  pollTimer = setInterval(() => {
    pollAllAccounts().catch(err => {
      logger.error('Gmail poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  firstPollTimer = setTimeout(() => {
    pollAllAccounts().catch(() => { /* logged inside */ });
  }, 10_000);
}

export function stopGmailWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Gmail watcher stopped');
  }
  if (firstPollTimer) {
    clearTimeout(firstPollTimer);
    firstPollTimer = null;
  }
}
