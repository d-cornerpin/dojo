// ════════════════════════════════════════
// Outlook Watcher: Polls each connected slot's inbox for new emails and
// notifies the primary agent. Multi-slot (agent + user) as of v2.7.1.
// Mirror of gmail-watcher.ts — see that file for the per-slot rationale.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { msGraphRead } from '../microsoft/client.js';
import {
  isMicrosoftEnabled, isMicrosoftConnected, getEnabledMsServices,
  isMsEmailMonitoringEnabled, ACCOUNT_SLOTS, type AccountSlot,
} from '../microsoft/auth.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError } from './watcher-status.js';

const logger = createLogger('outlook-watcher');

let pollTimer: ReturnType<typeof setInterval> | null = null;

const POLL_INTERVAL_MS = 300_000;
const MAX_RESULTS_PER_POLL = 50;

// ── Per-slot transient state ──

interface SlotState {
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

const slotState: Record<AccountSlot, SlotState> = {
  agent: makeEmptyState(),
  user: makeEmptyState(),
};

function makeEmptyState(): SlotState {
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

// ── Aggregated status ──

export function getOutlookWatcherStatus(): WatcherStatus {
  const slots = ACCOUNT_SLOTS.map(s => ({ slot: s, state: slotState[s] }));
  const monitored = slots.filter(({ slot }) =>
    isMicrosoftEnabled(slot) && isMicrosoftConnected(slot) && isMsEmailMonitoringEnabled(slot) && getEnabledMsServices(slot).outlook,
  );

  const enabled = monitored.length > 0;
  const connected = ACCOUNT_SLOTS.some(s => isMicrosoftConnected(s));
  const lastPollAt = pickLatest(slots.map(s => s.state.lastPollAt));
  const lastNotifiedAt = pickLatest(slots.map(s => s.state.lastNotifiedAt));
  const totalPolls = slots.reduce((a, s) => a + s.state.totalPolls, 0);
  const totalNotifications = slots.reduce((a, s) => a + s.state.totalNotifications, 0);
  const lastCheckedAt = pickLatest(slots.map(s => s.state.lastCheckedAt));

  const ok = slots.map(s => s.state.lastPollOk).filter((v): v is boolean => v !== null);
  const lastPollOk: boolean | null = ok.length === 0 ? null : ok.every(v => v);
  const lastPollError = slots.find(s => s.state.lastPollOk === false)?.state.lastPollError ?? null;
  const consecutiveFailures = slots.reduce((a, s) => Math.max(a, s.state.consecutiveFailures), 0);
  const firstFailureAt = pickEarliest(slots.map(s => s.state.firstFailureAt).filter((v): v is string => v !== null));

  const merged: RecentNotification[] = slots
    .flatMap(s => s.state.recentNotifications)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);

  return {
    name: 'outlook',
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

// ── Per-slot persistence ──

function lastCheckedKey(slot: AccountSlot): string {
  return slot === 'agent' ? 'outlook_last_checked_at' : `outlook_last_checked_at_${slot}`;
}

function notifiedKey(slot: AccountSlot): string {
  return slot === 'agent' ? 'outlook_notified_ids' : `outlook_notified_ids_${slot}`;
}

function loadLastCheckedAt(slot: AccountSlot): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(lastCheckedKey(slot)) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(slot: AccountSlot, timestamp: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(lastCheckedKey(slot), timestamp, timestamp);
  } catch (err) {
    logger.error('Failed to save outlook_last_checked_at', {
      slot, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Per-slot polling ──

async function pollSlot(slot: AccountSlot): Promise<void> {
  const s = slotState[slot];
  s.totalPolls++;
  const pollStartIso = new Date().toISOString();

  const recordSuccess = (): void => {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = true;
    s.lastPollError = null;
    s.consecutiveFailures = 0;
    s.firstFailureAt = null;
    if (s.alreadyAlerted) {
      logger.info('Outlook watcher recovered — sending recovery alert', { slot });
      s.alreadyAlerted = maybeAlertOnRecovery({
        name: 'outlook', alreadyAlerted: s.alreadyAlerted, totalNotificationsSinceFailure: s.notificationsSinceFailureAlert,
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
      name: 'outlook',
      consecutiveFailures: s.consecutiveFailures,
      firstFailureAt: s.firstFailureAt,
      lastError: msg,
      alreadyAlerted: s.alreadyAlerted,
    });
  };

  if (!isMicrosoftEnabled(slot) || !isMicrosoftConnected(slot)) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = !isMicrosoftEnabled(slot)
      ? `${slot} slot: Microsoft integration disabled`
      : `${slot} slot: not connected`;
    return;
  }
  if (!isMsEmailMonitoringEnabled(slot)) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = `${slot} slot: email monitoring disabled`;
    return;
  }
  const services = getEnabledMsServices(slot);
  if (!services.outlook) {
    s.lastPollAt = new Date().toISOString();
    s.lastPollOk = null;
    s.lastPollError = `${slot} slot: Outlook service disabled`;
    return;
  }

  try {
    const filter = s.lastCheckedAt ? `receivedDateTime gt ${s.lastCheckedAt}` : null;
    const filterClause = filter ? `&$filter=${encodeURIComponent(filter)}` : '';
    const endpoint = `me/mailFolders/inbox/messages?$top=${MAX_RESULTS_PER_POLL}${filterClause}&$select=id,from,subject,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`;

    const result = await msGraphRead(endpoint, 'system', 'Outlook Watcher', 'outlook_inbox_poll', { filter, slot }, slot);

    if (!result.ok) {
      logger.warn('Outlook poll failed', { slot, error: result.error });
      recordFailure(result.error ?? 'Unknown poll error');
      return;
    }

    const data = result.data as { value?: Array<{ id: string; from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; receivedDateTime?: string; bodyPreview?: string }> };
    if (!data?.value || data.value.length === 0) {
      s.lastCheckedAt = pollStartIso;
      saveLastCheckedAt(slot, pollStartIso);
      recordSuccess();
      return;
    }

    const db = getDb();
    const primaryId = getPrimaryAgentId();
    const nKey = notifiedKey(slot);
    let notifiedIds: Set<string>;
    try {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(nKey) as { value: string } | undefined;
      notifiedIds = new Set(row?.value ? JSON.parse(row.value) : []);
    } catch {
      notifiedIds = new Set();
    }

    const accountEmailKey = slot === 'agent' ? 'ms_account_email' : 'ms_user_account_email';
    const accountEmail = (() => {
      try {
        const row = db.prepare('SELECT value FROM config WHERE key = ?').get(accountEmailKey) as { value: string } | undefined;
        return row?.value ?? null;
      } catch { return null; }
    })();
    const notifyAccount = accountEmail ?? slot;
    const accountSuffix = slot === 'user' ? "user's Microsoft account" : "agent's Microsoft account";
    const toolHint = slot === 'agent' ? 'outlook_read' : 'user_outlook_read';

    let newCount = 0;

    for (const msg of data.value) {
      if (notifiedIds.has(msg.id)) continue;

      const fromName = msg.from?.emailAddress?.name ?? '';
      const fromAddress = msg.from?.emailAddress?.address ?? 'Unknown sender';
      const from = fromName ? `${fromName} <${fromAddress}>` : fromAddress;
      const subject = msg.subject ?? '(no subject)';
      const date = msg.receivedDateTime ?? '';
      const snippet = msg.bodyPreview ?? '';

      const content = `[SOURCE: OUTLOOK NOTIFICATION — ${notifyAccount} (${accountSuffix})]\n\nFrom: ${from}\nSubject: ${subject}\nDate: ${date}\nPreview: ${snippet}\nMessage ID: ${msg.id}\nUse \`${toolHint}\` to read the full body.`;

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
      s.totalNotifications++;
      if (s.alreadyAlerted) s.notificationsSinceFailureAlert++;
      s.lastNotifiedAt = new Date().toISOString();
      s.recentNotifications = pushRecent(s.recentNotifications, {
        at: s.lastNotifiedAt,
        from: `${from} → ${notifyAccount}`,
        subject,
      });

      logger.info('New Outlook email notification sent to primary agent', {
        slot, from, subject, messageId: msg.id,
      });
    }

    if (newCount > 0) {
      const runtime = getAgentRuntime();
      const summary = newCount === 1
        ? `[SOURCE: OUTLOOK NOTIFICATION] A new email just arrived in ${notifyAccount}. Details are in the previous message.`
        : `[SOURCE: OUTLOOK NOTIFICATION] ${newCount} new emails just arrived in ${notifyAccount}. Details are in the previous messages.`;

      runtime.handleMessage(primaryId, summary).catch(err => {
        logger.error('Failed to trigger runtime for new Outlook notification', {
          slot, error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const recentIds = [...notifiedIds].slice(-200);
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `).run(nKey, JSON.stringify(recentIds), JSON.stringify(recentIds));

    s.lastCheckedAt = pollStartIso;
    saveLastCheckedAt(slot, pollStartIso);
    recordSuccess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Outlook poll threw', { slot, error: msg });
    recordFailure(msg);
  }
}

async function pollAllSlots(): Promise<void> {
  for (const slot of ACCOUNT_SLOTS) {
    try {
      await pollSlot(slot);
    } catch (err) {
      logger.error('Outlook pollSlot threw outside catch', {
        slot, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Start/Stop ──

export function startOutlookWatcher(): void {
  if (pollTimer) {
    logger.warn('Outlook watcher already running');
    return;
  }

  for (const slot of ACCOUNT_SLOTS) {
    slotState[slot].lastCheckedAt = loadLastCheckedAt(slot);
    if (!slotState[slot].lastCheckedAt && isMicrosoftConnected(slot) && isMsEmailMonitoringEnabled(slot)) {
      const now = new Date().toISOString();
      slotState[slot].lastCheckedAt = now;
      saveLastCheckedAt(slot, now);
      logger.info('Outlook watcher: first run, seeded lastCheckedAt to now', { slot });
    }
  }

  const monitoredSlots = ACCOUNT_SLOTS.filter(s =>
    isMicrosoftConnected(s) && isMsEmailMonitoringEnabled(s) && getEnabledMsServices(s).outlook,
  );
  if (monitoredSlots.length === 0) {
    logger.info('Outlook watcher: no slots have email monitoring enabled, skipping');
    return;
  }

  logger.info('Starting Outlook watcher', {
    pollInterval: POLL_INTERVAL_MS,
    monitoredSlots,
  });

  pollTimer = setInterval(() => {
    pollAllSlots().catch(err => {
      logger.error('Outlook poll cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POLL_INTERVAL_MS);

  setTimeout(() => {
    pollAllSlots().catch(() => { /* logged inside */ });
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
