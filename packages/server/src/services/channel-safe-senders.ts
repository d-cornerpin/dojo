// ════════════════════════════════════════
// Per-channel safe-sender allowlists (v2.7.24)
//
// Each external channel (iMessage, Gmail, Outlook, Teams) has its own
// allowlist of senders the agent is authorized to AUTO-reply to. Adding
// someone to the iMessage list does NOT grant the agent permission to
// auto-reply to that same person's emails or Teams DMs — those are
// separate trust contexts maintained per channel.
//
// iMessage is the original allowlist (lives in services/imessage-bridge.ts
// under the `imessage_approved_senders` config key + bridge cache). The
// other three live here as thin wrappers around config-key-backed JSON.
//
// All four lists share the SafeSender shape + parseSafeSenders parser +
// addressesMatch helper from imessage-bridge.ts.
//
// Empty list ⇒ no one is on the allowlist ⇒ the engine will not auto-
// route inbound replies on that channel. The notification still arrives;
// the agent decides whether to surface it to the user. The agent can
// still send proactively or in-thread via the explicit tool call (subject
// to per-tool safety guards).
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { parseSafeSenders, type SafeSender } from './imessage-bridge.js';
import { configKeyToChannel, syncSafeSenderToContacts, syncSafeSendersToContacts } from '../contacts/from-safe-senders.js';

export type AccountSlot = 'agent' | 'user';

// v2.7.24 — gmail and outlook are per-slot (agent vs user mailbox), so each
// slot has its own safe-sender list. Adding Sarah to the agent slot's gmail
// list does NOT authorize the agent to auto-reply to Sarah's emails arriving
// at the user slot's gmail. This matches the per-slot "Allow sending email"
// toggle in the UI and the underlying isEmailSendingEnabled(slot) check.
// Teams runs on a single Microsoft account (no slot fan-out today), so its
// list stays single-keyed.

function gmailConfigKey(slot: AccountSlot): string {
  return `gmail_approved_senders_${slot}`;
}
function outlookConfigKey(slot: AccountSlot): string {
  return `outlook_approved_senders_${slot}`;
}
const TEAMS_CONFIG_KEY = 'teams_approved_senders';
// v2.9.18 — Twilio SMS senders and Voice callers. Single-keyed
// (not per-number) because a personal Twilio account typically has
// one or two numbers and the granular "is Sarah's phone trusted on
// Twilio number A but not B?" distinction isn't a real user need.
// Same shape as Teams.
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

export function getGmailSafeSenders(slot: AccountSlot): SafeSender[] {
  return readByKey(gmailConfigKey(slot));
}

export function getOutlookSafeSenders(slot: AccountSlot): SafeSender[] {
  return readByKey(outlookConfigKey(slot));
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

// v2.7.24 — append a sender to a channel's safe-sender list and persist.
// Used by the agent's add_safe_sender tool when the user asks the agent to
// start a conversation with someone on that channel. Dedup by address
// (case-insensitive); returns whether the addition was a new entry.
export interface AppendChannelSenderResult {
  ok: true;
  added: boolean;
  totalSenders: number;
}

function appendToKey(key: string, sender: SafeSender): AppendChannelSenderResult {
  const list = readByKey(key);
  const target = sender.address.toLowerCase();
  if (list.some((s) => s.address.toLowerCase() === target)) {
    return { ok: true, added: false, totalSenders: list.length };
  }
  const next = [...list, sender];
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(next));
  // Mirror the new sender into the contacts store (best-effort) so a trusted
  // name resolves when the user later asks the agent to reach them.
  const channel = configKeyToChannel(key);
  if (channel) syncSafeSenderToContacts(channel, sender, null);
  return { ok: true, added: true, totalSenders: next.length };
}

export function appendGmailSafeSender(slot: AccountSlot, sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(gmailConfigKey(slot), sender);
}
export function appendOutlookSafeSender(slot: AccountSlot, sender: SafeSender): AppendChannelSenderResult {
  return appendToKey(outlookConfigKey(slot), sender);
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

// Boot-time reconcile: mirror every safe-sender list (all channels + slots)
// into the contacts store on EVERY startup, so a trusted sender always has a
// contact record the agent can resolve by name.
//
// This used to be a one-time, config-flag-gated migration. The flag encoded a
// real intent: don't resurrect a contact the user deleted after the migration
// ran. But it also made the sweep fragile — if the flag was set on a boot
// BEFORE a sender was added via a path that (at that historical moment) didn't
// mirror live, that sender's contact never got created and the flag stopped the
// sweep from ever catching it (the production symptom: a saved iMessage safe
// sender with no contact row, so her outbound label showed the raw number).
//
// The live write paths (config PUT, appendToKey, the agent's iMessage write)
// already keep contacts in sync going forward, so this sweep is now a cheap,
// idempotent, self-healing safety net for anything added before mirroring
// existed. The mirror is additive + one-way (create-or-augment, never delete)
// and matches on the channel address, so re-running over the full lists every
// boot is a no-op once a sender is on file. The lists are small, so it runs
// inline. Accepted tradeoff of dropping the flag: a safe-sender-derived contact
// the user deleted while the sender is still on the allowlist can reappear on
// the next boot — the sender is still trusted, so recreating the name record is
// low-harm, and closing the "missing contact" gap is the priority.
export function backfillSafeSenderContacts(): { created: number; updated: number; skipped: boolean } {
  const db = getDb();

  let created = 0;
  let updated = 0;
  // Match every safe-sender list by key shape, then resolve its channel. This
  // catches the per-slot gmail/outlook keys without enumerating them.
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
