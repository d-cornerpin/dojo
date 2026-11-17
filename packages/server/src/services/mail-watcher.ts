// One mail watcher body for both providers (Gmail, Outlook): a timer polls every connected account's inbox, each
// account with its own cursor, processed list and failure state, so a flaky mailbox does not suppress the others.
// Each new mail is stored by `mail-record.ts`; the ones that wake the main agent wake it once per poll.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import type { MailService } from './channel-safe-senders.js';
import type { OwnerEmailOutcome } from './mail-owner-intake.js';
import { recordMail } from './mail-record.js';
import { addressesMatch } from './imessage-bridge.js';
import { listAgentSelfIdentities, matchSelfIdentity } from './self-identities.js';
import { MAX_MAILS_PER_POLL, persistNotifiedIds } from './notified-ids.js';
import type { MailAddressingFacts } from './mail-inbound-facts.js';
import { type WatcherStatus, type RecentNotification, pushRecent, maybeAlertOnFailure, maybeAlertOnRecovery, normalizeError, watcherFailingOnRecord, watchedForMail } from './watcher-status.js';

const POLL_INTERVAL_MS = 300_000;
const LOOKBACK_MARGIN_MS = 15 * 60 * 1000;

export interface MailAccountView {
  id: string;
  kind: 'agent' | 'user';
  email: string | null;
  enabled: boolean;
  connected: boolean;
  watchEmail: boolean;
  services: Partial<Record<MailService, boolean>>;
}

/** One mail as the body needs it, whichever provider read it. */
export interface MailItem {
  id: string;
  threadRoot: string;
  from: string;
  fromAddr: string;
  subject: string;
  date: string;
  snippet: string;
  addressing: MailAddressingFacts;
  /** When the mailbox received it, in ms: the cursor moves to it when a poll stops part-way. */
  receivedAt: number;
  owner: () => Promise<OwnerEmailOutcome>;
}

export interface MailProvider<Ref extends { id: string }> {
  name: MailService;
  company: 'Google' | 'Microsoft';
  /** The listing comes newest first, so every page is listed before the oldest mails are known. */
  newestFirst: boolean;
  views: () => MailAccountView[];
  /** One page of the inbox received after `since`; `next` continues the listing, null when done. */
  list: (view: MailAccountView, since: Date, next: string | null) => Promise<{ ok: true; refs: Ref[]; next: string | null } | { ok: false; error: string }>;
  /** The mail behind one listed ref, or null when it cannot be read now (it is tried again next poll). */
  read: (view: MailAccountView, ref: Ref) => Promise<MailItem | null>;
}

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
  /** Polls in a row each mail id could not be read on; at READ_TRIES the mail is passed. */
  readFailures: Map<string, number>;
}

const READ_TRIES = 3;

function pickLatest(times: Array<string | null>): string | null {
  const valid = times.filter((v): v is string => v !== null);
  return valid.length === 0 ? null : valid.sort().slice(-1)[0];
}

export class MailWatcher<Ref extends { id: string }> {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly NAME: 'GMAIL' | 'OUTLOOK';
  private readonly accountState = new Map<string, AccountWatchState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private firstPollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  constructor(private readonly p: MailProvider<Ref>) {
    this.logger = createLogger(`${p.name}-watcher`);
    this.NAME = p.name === 'gmail' ? 'GMAIL' : 'OUTLOOK';
  }

  // The 'agent' account's keys carry no suffix; every other account's carry its id.
  private configKey(what: 'last_checked_at' | 'notified_ids', accountId: string): string {
    return accountId === 'agent' ? `${this.p.name}_${what}` : `${this.p.name}_${what}_${accountId}`;
  }

  private readConfig(key: string): string | null {
    try {
      return (getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    } catch { return null; }
  }

  private saveLastCheckedAt(accountId: string, timestamp: string): void {
    this.stateFor(accountId).lastCheckedAt = timestamp;
    try {
      getDb().prepare(`
        INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(this.configKey('last_checked_at', accountId), timestamp, timestamp);
    } catch (err) {
      this.logger.error('Failed to save the mail cursor', { accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Created on first sight (so accounts added at runtime are polled) with the cursor saved for it, if any.
  private stateFor(accountId: string): AccountWatchState {
    let s = this.accountState.get(accountId);
    if (!s) {
      s = {
        lastCheckedAt: this.readConfig(this.configKey('last_checked_at', accountId)),
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
        readFailures: new Map(),
      };
      this.accountState.set(accountId, s);
    }
    return s;
  }

  status(): WatcherStatus {
    const views = this.p.views();
    const states = views.map(v => this.stateFor(v.id));
    // lastPollOk: false if any account's last poll failed, true if all succeeded, null if none polled or all skipped.
    const ok = states.map(s => s.lastPollOk).filter((v): v is boolean => v !== null);
    return {
      name: this.p.name,
      running: this.pollTimer !== null,
      enabled: views.some(v => v.connected && watchedForMail(v, this.p.name)),
      connected: views.some(v => v.connected),
      pollIntervalMs: POLL_INTERVAL_MS,
      lastPollAt: pickLatest(states.map(s => s.lastPollAt)),
      lastPollOk: ok.length === 0 ? null : ok.every(v => v),
      lastPollError: states.find(s => s.lastPollOk === false)?.lastPollError ?? null,
      consecutiveFailures: states.reduce((a, s) => Math.max(a, s.consecutiveFailures), 0),
      firstFailureAt: states.map(s => s.firstFailureAt).filter((v): v is string => v !== null).sort()[0] ?? null,
      lastCheckedAt: pickLatest(states.map(s => s.lastCheckedAt)),
      totalPolls: states.reduce((a, s) => a + s.totalPolls, 0),
      totalNotifications: states.reduce((a, s) => a + s.totalNotifications, 0),
      lastNotifiedAt: pickLatest(states.map(s => s.lastNotifiedAt)),
      recentNotifications: states.flatMap(s => s.recentNotifications).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 10),
    };
  }

  private recordSuccess(accountId: string, s: AccountWatchState): void {
    Object.assign(s, { lastPollAt: new Date().toISOString(), lastPollOk: true, lastPollError: null, consecutiveFailures: 0, firstFailureAt: null });
    if (s.alreadyAlerted || watcherFailingOnRecord(this.p.name, accountId)) {
      this.logger.info('Mail watcher recovered, sending the recovery alert', { accountId });
      s.alreadyAlerted = maybeAlertOnRecovery({ name: this.p.name, accountId, alreadyAlerted: s.alreadyAlerted, totalNotificationsSinceFailure: s.notificationsSinceFailureAlert });
      s.notificationsSinceFailureAlert = 0;
    }
  }

  private recordFailure(accountId: string, s: AccountWatchState, rawMsg: string): void {
    const msg = normalizeError(rawMsg);
    const nowIso = new Date().toISOString();
    Object.assign(s, { lastPollAt: nowIso, lastPollOk: false, lastPollError: msg, consecutiveFailures: s.consecutiveFailures + 1 });
    if (!s.firstFailureAt) s.firstFailureAt = nowIso;
    s.alreadyAlerted = maybeAlertOnFailure({ name: this.p.name, accountId, consecutiveFailures: s.consecutiveFailures, firstFailureAt: s.firstFailureAt, lastError: msg, alreadyAlerted: s.alreadyAlerted });
  }

  // Why an account is not polled, recorded as a non-error skip so the status can say why nothing happens.
  private skipReason(v: MailAccountView): string | null {
    const label = v.email ?? `${v.kind} account`;
    if (!v.enabled) return `${label}: ${this.p.company} integration disabled`;
    if (!v.connected) return `${label}: not connected`;
    if (!v.watchEmail) return `${label}: email monitoring disabled`;
    if (!v.services[this.p.name]) return `${label}: ${this.p.name === 'gmail' ? 'Gmail' : 'Outlook'} service disabled`;
    return null;
  }

  /** The oldest mails since `since` not yet handled, at most MAX_MAILS_PER_POLL, oldest first; `more` when some wait. */
  private async listSince(view: MailAccountView, since: Date, handled: ReadonlySet<string>): Promise<{ ok: true; refs: Ref[]; more: boolean } | { ok: false; error: string }> {
    const refs: Ref[] = [];
    let next: string | null = null;
    do {
      const page = await this.p.list(view, since, next);
      if (!page.ok) return page;
      refs.push(...page.refs.filter((r) => !handled.has(r.id)));
      next = page.next;
    } while (next && (this.p.newestFirst || refs.length < MAX_MAILS_PER_POLL));
    if (this.p.newestFirst) refs.reverse();
    return { ok: true, refs: refs.slice(0, MAX_MAILS_PER_POLL), more: next !== null || refs.length > MAX_MAILS_PER_POLL };
  }

  private async pollAccount(view: MailAccountView): Promise<void> {
    const accountId = view.id;
    const s = this.stateFor(accountId);
    s.totalPolls++;
    const pollStartIso = new Date().toISOString();
    const skip = this.skipReason(view);
    if (skip) {
      Object.assign(s, { lastPollAt: pollStartIso, lastPollOk: null, lastPollError: skip });
      return;
    }
    try {
      // First poll of a newly monitored account: the baseline is "now" and the existing inbox is never replayed.
      if (!s.lastCheckedAt) {
        this.saveLastCheckedAt(accountId, pollStartIso);
        this.recordSuccess(accountId, s);
        this.logger.info('Mail watcher: baseline set for a newly monitored account', { accountId });
        return;
      }
      const nKey = this.configKey('notified_ids', accountId);
      let handled: Set<string>;
      try { handled = new Set(JSON.parse(this.readConfig(nKey) ?? '[]') as string[]); } catch { handled = new Set(); }
      const listed = await this.listSince(view, new Date(Math.max(0, new Date(s.lastCheckedAt).getTime() - LOOKBACK_MARGIN_MS)), handled);
      if (!listed.ok) {
        this.logger.warn('Mail poll failed', { accountId, error: listed.error });
        this.recordFailure(accountId, s, listed.error);
        return;
      }
      const { woken, stoppedAt, lastAt } = await this.announce(view, s, listed.refs, handled, nKey);
      if (woken > 0) {
        const notifyAccount = view.email ?? view.kind;
        // Neutral trigger: the per-email rows carry the real framing, so this must not contradict them.
        const summary = woken === 1
          ? `[SOURCE: ${this.NAME} NOTIFICATION] New email in ${notifyAccount}. Details above — act on it as the framing there indicates.`
          : `[SOURCE: ${this.NAME} NOTIFICATION] ${woken} new emails in ${notifyAccount}. Details above — act on each as the framing there indicates.`;
        getAgentRuntime().handleMessage(getPrimaryAgentId(), summary).catch(err => {
          this.logger.error('Failed to wake the main agent for new email', { accountId, error: err instanceof Error ? err.message : String(err) });
        });
      }
      // A poll that stopped part-way moves the cursor only to the last mail it handled, so no waiting mail is passed,
      // and the cursor never moves back.
      const current = new Date(s.lastCheckedAt).getTime();
      if (stoppedAt === null && !listed.more) this.saveLastCheckedAt(accountId, pollStartIso);
      else if (lastAt !== null && lastAt > current) this.saveLastCheckedAt(accountId, new Date(lastAt).toISOString());
      if (stoppedAt === null) this.recordSuccess(accountId, s);
      else this.recordFailure(accountId, s, `could not read mail ${stoppedAt}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('Mail poll threw', { accountId, error: msg });
      this.recordFailure(accountId, s, msg);
    }
  }

  /** Records each listed mail, oldest first, so the capped processed list keeps the newest ids. Returns how many
   *  were stored for the first time and wake the agent, the id of a mail whose failed read stopped it, and the
   *  received time of the last mail it handled. */
  private async announce(view: MailAccountView, s: AccountWatchState, refs: Ref[], notifiedIds: Set<string>, nKey: string): Promise<{ woken: number; stoppedAt: string | null; lastAt: number | null }> {
    const selfIdentities = listAgentSelfIdentities();
    let woken = 0;
    let lastAt: number | null = null;
    for (const ref of refs) {
      const mail = await this.p.read(view, ref);
      if (!mail) {
        // A mail that fails on READ_TRIES polls in a row is passed, so one bad mail cannot hold the mailbox.
        const tries = (s.readFailures.get(ref.id) ?? 0) + 1;
        s.readFailures.set(ref.id, tries);
        if (tries < READ_TRIES) {
          this.logger.warn('Mail read failed; this poll stops here and the next one starts from this mail', { accountId: view.id, messageId: ref.id, tries });
          return { woken, stoppedAt: ref.id, lastAt };
        }
        this.logger.error('Mail could not be read on three polls in a row; it is passed', { accountId: view.id, messageId: ref.id });
        s.readFailures.delete(ref.id);
        notifiedIds.add(ref.id);
        persistNotifiedIds(nKey, notifiedIds);
        continue;
      }
      s.readFailures.delete(ref.id);
      if (Number.isFinite(mail.receivedAt)) lastAt = mail.receivedAt;
      // The agent's own outbound never wakes it (cost, reply loops): the sender is this mailbox or another agent mailbox.
      const self = mail.fromAddr && (matchSelfIdentity(mail.fromAddr, selfIdentities) ?? (view.email && addressesMatch(mail.fromAddr, view.email) ? view.email : null));
      if (self) {
        this.logger.info('Mail poll: skipping self-sent', { accountId: view.id, messageId: mail.id, selfIdentity: self });
      } else {
        const stored = await recordMail(this.p, view, mail);
        if (stored !== 'seen') {
          if (stored === 'wakes') woken++;
          s.totalNotifications++;
          if (s.alreadyAlerted) s.notificationsSinceFailureAlert++;
          s.lastNotifiedAt = new Date().toISOString();
          s.recentNotifications = pushRecent(s.recentNotifications, { at: s.lastNotifiedAt, from: `${mail.from} → ${view.email ?? view.kind}`, subject: mail.subject });
        }
      }
      notifiedIds.add(ref.id);
      persistNotifiedIds(nKey, notifiedIds);   // after each mail, so a poll that throws later does not re-read it
    }
    return { woken, stoppedAt: null, lastAt };
  }

  // One poll at a time: a slow poll still running when the timer fires again is not joined by a second.
  private async pollAllAccounts(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const view of this.p.views()) {
        try {
          await this.pollAccount(view);
        } catch (err) {
          this.logger.error('pollAccount threw outside its catch', { accountId: view.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // The timer always runs: each poll skips the accounts that are off or disconnected, so one connected later is watched.
  start(): void {
    if (this.pollTimer) return;
    this.accountState.clear();   // re-read every cursor, so a baseline the dashboard just set takes effect
    this.pollTimer = setInterval(() => { this.pollAllAccounts().catch(() => { /* logged inside */ }); }, POLL_INTERVAL_MS);
    this.firstPollTimer = setTimeout(() => { this.pollAllAccounts().catch(() => { /* logged inside */ }); }, 10_000);
    this.logger.info('Mail watcher started', { pollInterval: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.firstPollTimer) clearTimeout(this.firstPollTimer);
    this.pollTimer = null;
    this.firstPollTimer = null;
  }

  /** Reset an account's cursor to now, so only mail arriving from here on is announced (watch-email turned on). */
  markBaselineNow(accountId: string): void {
    this.saveLastCheckedAt(accountId, new Date().toISOString());
  }
}
