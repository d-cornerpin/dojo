// Per-channel safe-sender allowlists: each external channel keeps its own list of senders the agent may AUTO-reply
// to, so being on one channel's list grants nothing on another. iMessage's list lives in imessage-bridge.ts;
// all lists share its SafeSender shape and parser. An empty list means no auto-routing of inbound replies on that
// channel (the notification still arrives).

import { getDb } from '../db/connection.js';
import { addressesMatch, parseSafeSenders, type SafeSender } from './imessage-bridge.js';
import { configKeyToChannel, syncSafeSenderToContacts, syncSafeSendersToContacts } from '../contacts/from-safe-senders.js';
import { listGoogleAccounts } from '../google/accounts.js';
import { listMicrosoftAccounts } from '../microsoft/accounts.js';
import { isOwnerAddress } from './owner-mailboxes.js';

export type MailService = 'gmail' | 'outlook';

// Gmail and Outlook keep one list per mailbox, keyed by its account id (the key the Settings page writes);
// Teams runs on one Microsoft account, so its list is single-keyed.
const mailKey = (service: MailService, accountId: string): string => `${service}_approved_senders_${accountId}`;
const TEAMS_CONFIG_KEY = 'teams_approved_senders';
// Twilio SMS senders and Voice callers are single-keyed (not per number), the same shape as Teams.
const TWILIO_SMS_CONFIG_KEY = 'twilio_sms_approved_senders';
const TWILIO_VOICE_CONFIG_KEY = 'twilio_voice_approved_callers';

function readByKey(key: string): SafeSender[] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return parseSafeSenders(row?.value ?? null);
  } catch {
    return [];
  }
}

export function getMailSafeSenders(service: MailService, accountId: string): SafeSender[] {
  return readByKey(mailKey(service, accountId));
}

/** Every approved list of a provider's mailboxes, of one kind or of all. */
export function mailboxesSafeSenders(service: MailService, kind?: 'agent' | 'user'): SafeSender[] {
  const accounts = service === 'gmail' ? listGoogleAccounts(kind) : listMicrosoftAccounts(kind);
  return accounts.flatMap((a) => getMailSafeSenders(service, a.id));
}

export function onMailList(service: MailService, accountId: string, address: string): boolean {
  return !!address && getMailSafeSenders(service, accountId).some((s) => addressesMatch(s.address, address));
}

/** Whether a new message wakes the main agent: mail to its own mailbox, from the owner, or from a sender on that
 *  mailbox's approved list. Anything else waits for the agent's next turn. */
export function senderWakes(channel: MailService, account: { id: string; kind: 'agent' | 'user' }, address: string): boolean {
  return account.kind === 'agent' || isOwnerAddress(address) || onMailList(channel, account.id, address.trim().toLowerCase());
}

export function getTeamsSafeSenders(): SafeSender[] {
  return readByKey(TEAMS_CONFIG_KEY);
}

export function getTwilioSmsSafeSenders(): SafeSender[] {
  return readByKey(TWILIO_SMS_CONFIG_KEY);
}

export function getTwilioVoiceSafeCallers(): SafeSender[] {
  return readByKey(TWILIO_VOICE_CONFIG_KEY);
}

// Append a sender to a channel's list (dedup by address, case-insensitive); returns whether it was new.
export interface AppendChannelSenderResult {
  ok: true;
  added: boolean;
  totalSenders: number;
}

function writeKey(key: string, list: SafeSender[]): void {
  getDb().prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(list));
}

function appendToKey(key: string, sender: SafeSender): AppendChannelSenderResult {
  const list = readByKey(key);
  const target = sender.address.toLowerCase();
  if (list.some((s) => s.address.toLowerCase() === target)) {
    return { ok: true, added: false, totalSenders: list.length };
  }
  const next = [...list, sender];
  writeKey(key, next);
  // Mirror the new sender into the contacts store (best-effort) so a trusted
  // name resolves when the user later asks the agent to reach them.
  const channel = configKeyToChannel(key);
  if (channel) syncSafeSenderToContacts(channel, sender, null);
  return { ok: true, added: true, totalSenders: next.length };
}

// Remove a sender from a channel's list by address, case-insensitive; its mirrored contact stays.
function removeFromKey(key: string, address: string): { removed: boolean; totalSenders: number } {
  const list = readByKey(key);
  const next = list.filter((s) => s.address.toLowerCase() !== address.toLowerCase());
  if (next.length === list.length) return { removed: false, totalSenders: list.length };
  writeKey(key, next);
  return { removed: true, totalSenders: next.length };
}

/** A list saved under a slot name ('agent', 'user') belongs to that kind's first mailbox when no account has that
 *  id (a mailbox connected from the dashboard has a random one): it is merged there once, at start. */
export function moveSlotListsToMailboxes(): void {
  for (const service of ['gmail', 'outlook'] as const) {
    for (const kind of ['agent', 'user'] as const) {
      const accounts = service === 'gmail' ? listGoogleAccounts(kind) : listMicrosoftAccounts(kind);
      const old = readByKey(mailKey(service, kind));
      if (old.length === 0 || accounts.length === 0 || accounts.some((a) => a.id === kind)) continue;
      for (const sender of old) appendToKey(mailKey(service, accounts[0].id), sender);
      getDb().prepare('DELETE FROM config WHERE key = ?').run(mailKey(service, kind));
    }
  }
}

export function appendMailSafeSender(service: MailService, accountId: string, sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(mailKey(service, accountId), sender);
}
export function appendTeamsSafeSender(sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(TEAMS_CONFIG_KEY, sender);
}
export function appendTwilioSmsSafeSender(sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(TWILIO_SMS_CONFIG_KEY, sender);
}
export function appendTwilioVoiceSafeCaller(sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(TWILIO_VOICE_CONFIG_KEY, sender);
}
export function removeTwilioSmsSafeSender(address: string): { removed: boolean; totalSenders: number } {
  return removeFromKey(TWILIO_SMS_CONFIG_KEY, address);
}
export function removeTwilioVoiceSafeCaller(address: string): { removed: boolean; totalSenders: number } {
  return removeFromKey(TWILIO_VOICE_CONFIG_KEY, address);
}

// Boot-time reconcile: mirror every safe-sender list into the contacts store on EVERY startup, so a trusted sender
// always has a contact the agent can resolve by name. The mirror is additive and one-way (create or augment,
// never delete), so a contact the user deleted can reappear while its sender stays on the allowlist.
// It matches on the channel address, so a re-run is a no-op once a sender is on file; the lists are small.
export function backfillSafeSenderContacts(): { created: number; updated: number; skipped: boolean } {
  const db = getDb();

  let created = 0;
  let updated = 0;
  // Match every safe-sender list by key shape (catches the per-mailbox gmail/outlook keys without listing them).
  const rows = db
    .prepare("SELECT key, value FROM config WHERE key LIKE '%approved_senders%' OR key LIKE '%approved_callers%'")
    .all() as Array<{ key: string; value: string }>;
  for (const { key, value } of rows) {
    const channel = configKeyToChannel(key);
    if (!channel) continue;
    const r = syncSafeSendersToContacts(channel, parseSafeSenders(value), null);
    created += r.created;
    updated += r.updated;
  }

  return { created, updated, skipped: false };
}
